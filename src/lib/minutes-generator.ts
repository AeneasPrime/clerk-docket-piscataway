import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { exec } from "child_process";
import { promisify } from "util";
const execAsync = promisify(exec);
import { existsSync, unlinkSync, statSync, createReadStream } from "fs";
import path from "path";
import os from "os";
import type { DocketEntry } from "@/types";
import { getMeeting, getAgendaItemsForMeeting, updateMeeting, getMeetingsNeedingMinutes, getOrdinanceTracking, upsertOrdinanceTracking, getNextCouncilMeetingAfter } from "./db";

let _anthropic: Anthropic | null = null;
function getClient(): Anthropic {
  if (!_anthropic) {
    _anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return _anthropic;
}

// --- YouTube transcript fetching ---

export type TranscriptSource = "youtube_captions" | "whisper";

interface TranscriptData {
  transcript: string;
  chapters: string;
  showTitle: string;
  source: TranscriptSource;
}

function extractVideoId(videoUrl: string): string | null {
  const match = videoUrl.match(/[?&]v=([^&]+)/) ?? videoUrl.match(/youtu\.be\/([^?]+)/);
  return match ? match[1] : null;
}

/**
 * Try to fetch YouTube's auto-generated captions via yt-dlp.
 * Returns the transcript text or null if unavailable.
 */
async function fetchYouTubeCaptions(videoUrl: string): Promise<string | null> {
  const videoId = extractVideoId(videoUrl);
  if (!videoId) return null;

  const tmpDir = os.tmpdir();
  const subtitleBase = path.join(tmpDir, `piscataway-captions-${videoId}`);

  try {
    // Download auto-generated English captions using yt-dlp
    await execAsync(
      `yt-dlp --write-auto-sub --sub-lang en --sub-format vtt --skip-download ` +
      `--output "${subtitleBase}" "${videoUrl}" 2>/dev/null`,
      { timeout: 30000 }
    );

    // yt-dlp creates files like: <base>.en.vtt
    const vttPath = `${subtitleBase}.en.vtt`;
    if (!existsSync(vttPath)) return null;

    const vtt = await import("fs").then(fs => fs.readFileSync(vttPath, "utf-8"));

    // Parse VTT → plain text with periodic timestamp markers (every ~60 seconds)
    const lines = vtt.split("\n");
    let transcript = "";
    let lastText = "";
    let lastTimestampSecs = -60; // force first timestamp to appear
    let currentTimestamp = "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed === "WEBVTT" || /^\d+$/.test(trimmed) || trimmed.startsWith("Kind:") || trimmed.startsWith("Language:")) continue;

      // Parse timestamp lines like "00:01:23.456 --> 00:01:26.789"
      const tsMatch = trimmed.match(/^(\d{2}):(\d{2}):(\d{2})\.\d+\s*-->/);
      if (tsMatch) {
        const h = parseInt(tsMatch[1]), m = parseInt(tsMatch[2]), s = parseInt(tsMatch[3]);
        const totalSecs = h * 3600 + m * 60 + s;
        // Insert timestamp marker every ~60 seconds (don't clear pending unused timestamps)
        if (totalSecs - lastTimestampSecs >= 60) {
          const display = h > 0 ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
          currentTimestamp = `[${display}] `;
          lastTimestampSecs = totalSecs;
        }
        continue;
      }

      // Skip other non-text lines
      if (trimmed.includes("-->")) continue;

      // Clean HTML tags from caption text
      const clean = trimmed.replace(/<[^>]+>/g, "").trim();
      if (clean && clean !== lastText) {
        transcript += currentTimestamp + clean + "\n";
        currentTimestamp = ""; // only prepend timestamp to first line after a new cue
        lastText = clean;
      }
    }

    // Clean up temp file
    try { unlinkSync(vttPath); } catch {}

    return transcript.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Fetch transcript from YouTube video. Tries captions first, falls back to Whisper.
 */
export async function fetchTranscriptData(videoUrl: string): Promise<TranscriptData> {
  const videoId = extractVideoId(videoUrl);
  if (!videoId) throw new Error(`Cannot extract video ID from URL: ${videoUrl}`);

  // Try YouTube auto-captions first (free, fast)
  const captions = await fetchYouTubeCaptions(videoUrl);
  if (captions && captions.length > 500) {
    return {
      transcript: captions,
      chapters: "",
      showTitle: "",
      source: "youtube_captions",
    };
  }

  // Fall back to Whisper transcription
  return fetchWhisperTranscript(videoUrl);
}

/**
 * Download YouTube audio via yt-dlp and transcribe with OpenAI Whisper.
 */
export async function fetchWhisperTranscript(videoUrl: string): Promise<TranscriptData> {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is required for Whisper transcription. Add it to .env.local.");
  }

  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const videoId = extractVideoId(videoUrl);
  if (!videoId) throw new Error(`Cannot extract video ID from URL: ${videoUrl}`);

  const tmpDir = os.tmpdir();
  const audioPath = path.join(tmpDir, `piscataway-meeting-${videoId}.mp3`);

  try {
    console.log(`Downloading audio from YouTube: ${videoUrl}...`);
    // Use yt-dlp to download audio directly as mp3
    await execAsync(
      `yt-dlp -x --audio-format mp3 --audio-quality 6 --postprocessor-args "-ar 16000 -ac 1" ` +
      `--output "${audioPath.replace('.mp3', '.%(ext)s')}" "${videoUrl}" 2>/dev/null`,
      { timeout: 600000 }
    );

    // yt-dlp may output with different extension before conversion
    if (!existsSync(audioPath)) {
      // Try to find the output file
      const { stdout } = await execAsync(`ls ${path.join(tmpDir, `piscataway-meeting-${videoId}`)}* 2>/dev/null`);
      const found = stdout.trim().split("\n")[0];
      if (found && existsSync(found)) {
        // Convert to mp3 if needed
        if (!found.endsWith(".mp3")) {
          await execAsync(`ffmpeg -i "${found}" -ar 16000 -ac 1 -q:a 6 "${audioPath}" -y 2>/dev/null`, { timeout: 300000 });
          try { unlinkSync(found); } catch {}
        }
      }
    }

    if (!existsSync(audioPath)) {
      throw new Error("Failed to download audio from YouTube. Is yt-dlp installed?");
    }

    const stats = statSync(audioPath);
    const sizeMB = stats.size / (1024 * 1024);
    console.log(`Audio downloaded: ${sizeMB.toFixed(1)}MB`);

    if (sizeMB > 25) {
      throw new Error(
        `Audio file is ${sizeMB.toFixed(1)}MB (Whisper API limit is 25MB). ` +
        `This meeting may be too long for single-pass transcription.`
      );
    }

    console.log("Sending to Whisper API...");
    const transcription = await openai.audio.transcriptions.create({
      model: "whisper-1",
      file: createReadStream(audioPath),
      response_format: "verbose_json",
      language: "en",
      prompt: "Piscataway Township Municipal Council meeting. Council members: Cahill, Dawkins, Lombardi, Saunders, Seker, Spencer, Waterman. Mayor Wahler.",
    });

    const result = transcription as unknown as {
      text: string;
      segments: Array<{ start: number; end: number; text: string }>;
    };

    let formatted = "";
    if (result.segments) {
      for (const segment of result.segments) {
        const mins = Math.floor(segment.start / 60);
        const secs = Math.floor(segment.start % 60);
        formatted += `[${mins}:${secs.toString().padStart(2, "0")}] ${segment.text.trim()}\n`;
      }
    }

    console.log(`Whisper transcription complete: ${(formatted || result.text).length} chars`);

    return {
      transcript: formatted || result.text || "",
      chapters: "",
      showTitle: "",
      source: "whisper",
    };
  } finally {
    if (existsSync(audioPath)) {
      unlinkSync(audioPath);
    }
  }
}

// --- Minutes generation ---

function buildSystemPrompt(meetingType: "council" | "reorganization", transcriptSource: TranscriptSource = "youtube_captions"): string {
  const transcriptNote = transcriptSource === "whisper"
    ? `The transcript was produced by OpenAI Whisper with proper capitalization and timestamps per segment (e.g. [12:34]). Higher quality than default but may still misrecognize names.`
    : `The transcript is from YouTube auto-generated captions. It may have misrecognitions, missing punctuation, and incorrect capitalization. You MUST carefully correct names using the known names below.`;

  return `You are the Deputy Township Clerk producing official minutes for the Township of Piscataway, Middlesex County, New Jersey (Faulkner Act Mayor-Council form of government).

You will be given a transcript, chapter markers, and agenda items. Produce minutes that match the EXACT style and format used by Piscataway Township. These minutes are LONG and DETAILED — typically 15-20+ pages when printed. Do NOT abbreviate or summarize excessively.

TRANSCRIPT NOTE: ${transcriptNote}

KNOWN NAMES — use these EXACT spellings (the transcript WILL misspell them):
- Mayor: Brian C. Wahler
- Council President: Michele Lombardi (Ward 4)
- Council Vice President: Sharon Carmichael (Ward 3)
- Councilmember: Gabrielle Cahill (At-Large)
- Councilmember: Laura Leibowitz (At-Large) — transcript may say "Liowitz", "Lebowitz", etc.
- Councilmember: Sarah Rashid (At-Large)
- Councilmember: Frank Uhrin (Ward 1) — transcript may say "Erin", "Urin", etc.
- Councilmember: Dennis Espinosa (Ward 2)
- Township Clerk: Melissa A. Seader
- Chief of Staff: Dana Korbman
- Township Attorney: Raj Goomer
- Business Administrator: Paula Cozzarelli
- Public Safety Director: Keith Stith
- Finance Director: Padmaja Rao
- Public Works Director: Guy Gaspari
- Parks & Recreation Director: John Tierney
- PCTV Director: George Fairfield

ABSOLUTE RULES:
- Output plain text only — NO markdown (no #, **, ---, bullet points)
- Do NOT invent information. If unclear, use a [REVIEW:] marker (see below).
- "Councilmembers" is ONE word (not "Council Members" or "Council members")
- "Councilmember" (singular) when referring to one person: "Councilmember Cahill asked..."
- All discussion is PARAPHRASED, never verbatim quoted
- Include FULL text of all resolutions with WHEREAS/NOW THEREFORE clauses
- Include FULL text of all ordinances
- Include FULL text of all proclamations
- CRITICAL: The ANNOUNCEMENTS section (section 14) has a HARD LIMIT of 30 words per person.
- CRITICAL: ALL public speaker comments EVERYWHERE in the document (sections 9, 10, 16, 17) must be 1-2 sentences max per person. NEVER reproduce what someone said at length. Summarize in 1-2 sentences only. A speaker who talked for 5 minutes gets 1-2 sentences. This applies equally to ordinance public comments (section 10) and general public comments (sections 16/17). The minutes should be ~45,000 characters total — if it's longer, your comments are too verbose.

REVIEW MARKERS — when information is unclear in the transcript, insert a marker so the clerk can review:
- Format: [REVIEW: description @MM:SS] where MM:SS is the approximate transcript timestamp
- Use for: unclear speaker names, inaudible amounts/numbers, uncertain vote counts, garbled proper nouns, missing resolution/certification numbers
- Place the marker INLINE where the uncertain text appears
- *** EVERY [REVIEW:] marker MUST include an @MM:SS timestamp. NO EXCEPTIONS. ***
  The transcript contains timestamp markers every ~60 seconds like [12:34]. For each review marker, find the nearest transcript timestamp to where that topic was being discussed and include it. Even for administrative details like resolution numbers or certification numbers, include the timestamp of when that resolution was being discussed so the clerk can jump to the relevant section of the video for context.
- Examples:
  - "Councilmember [REVIEW: speaker name unclear @14:32] made a motion..."
  - "...in the amount not to exceed [REVIEW: amount unclear @22:15]..."
  - "[REVIEW: vote count uncertain @45:01] answered yes."
  - "[REVIEW: full ordinance text needed @13:22]"
  - "RESOLUTION #26-[REVIEW: number needed @12:21]"
  - "WHEREAS, funds are available pursuant to certification #[REVIEW: number needed @12:21];"
- Do NOT use [REVIEW:] for boilerplate text you already know (OPMA statement, resolution templates, etc.)
- Only use [REVIEW:] for facts that come from the transcript and are genuinely unclear

=== EXACT STRUCTURE (follow this order precisely) ===

1. DATE HEADER:
Just the date alone on a line, e.g.:
February 10, 2026

2. OPENING PARAGRAPH:
"A Regular Meeting of the Piscataway Township Council was held on [full date] at the Piscataway Municipal Building, 455 Hoes Lane, Piscataway, New Jersey."

3. CALL TO ORDER:
"The meeting was called to order by Council President [Last Name] at [time] p.m."
Use LAST NAME ONLY throughout the minutes when referring to Council President, Councilmembers, etc. (e.g. "Council President Lombardi" not "Council President Michele Lombardi"). Full names only appear in the roll call and signature block.

4. OPEN PUBLIC MEETINGS ACT STATEMENT (include this FULL text):
"Council President [Name] made the following Statement, in compliance with the Open Public Meetings Act: Adequate notice of this meeting has been provided as required under Chapter 231, P.L. 1975, specifying the time, date, location, login, or dial-in information, and, to the extent known, the agenda by posting a copy of the notice on the Municipal Building, Municipal Court and the two Municipal Library Bulletin Boards Municipal Website, providing a copy to the official newspapers of the Township and by filing a copy in the office of the Township Clerk in accordance with a certification by the Clerk which will be entered in the minutes."

5. PUBLIC COMMENT NOTICE:
"There will be public comment periods for both remote and in person attendees separately. Each member of the public shall only have one opportunity to speak during each public portion. As the technology does not allow us to know if there are multiple callers on an individual phone line or logged in user account, we ask that if you wish to speak, that you login in or dial in separately so that we can recognize you as a separate individual."
[blank line]
"Should you have any further comments or questions, the Township Council is always available by email and phone, and you can always call the Mayor's office during normal operating hours."

6. ROLL CALL:
"On roll call, there were present: Councilmembers [last names only, alphabetical], & Council President [last name]."
Use LAST NAMES ONLY for roll call (e.g. "Cahill, Carmichael, Espinosa, Leibowitz, Rashid, Uhrin" — NOT full names).
If someone absent: "Absent: Councilmember [Last Name]."

7. FLAG SALUTE:
"Council President [Name] led the salute to the flag."

8. PROCLAMATIONS (if any — include FULL text):
"Council President [Name] read the following proclamation:"
Then the FULL proclamation text with all WHEREAS clauses and NOW THEREFORE declaration, exactly as read. End with the Mayor's name and title.

9. PUBLIC COMMENT ON CONSENT AGENDA (two separate sections):
"Council President [Name] opened the meeting to the remote attendees for comments regarding the Consent Agenda items."
If no comments: "There being no comments, this portion of the meeting was closed to the public."
If comments: Summarize each speaker (name, address, brief summary of comments) as plain paragraphs (NO bullet points here), then "There being no further comments, this portion of the meeting was closed to the public."

Then same for in-person:
"Council President [Name] opened the meeting to the in person attendees for comments regarding the Consent Agenda items."
Same format (plain paragraphs, no bullets).

9a. COMMENTS FROM ADMINISTRATION AND COUNCIL REGARDING ADJOURNMENT OF ANY MATTERS ON THIS AGENDA:
If any councilmember or administrator made a motion or statement about removing/adjourning items from the agenda BEFORE the ordinance readings, include it here as plain paragraphs. This includes motions to remove ordinances, requests to vote on consent items separately, etc. Include roll call votes on any such motions.

10. ORDINANCES — SECOND READING (each ordinance separately):
"The Clerk read for SECOND READING the following ORDINANCE:"
Then the FULL ordinance text including all WHEREAS and NOW THEREFORE clauses, section numbers, and legal text. Write out the complete ordinance as it appears on the agenda.

Then public comment (remote then in-person separately) as PLAIN PARAGRAPHS (NO bullet points — bullets are ONLY used in the "OPEN TO PUBLIC" sections 16/17 at the end):
"Council President [Name] opened the meeting to remote attendees for comments."
*** EACH SPEAKER GETS 1-2 SENTENCES ONLY. DO NOT REPRODUCE THEIR SPEECH. ***
Format from real Piscataway minutes:
"Jessica Kratovil, 1247 Brookside Rd, urged the Council to not pass the ordinance as it currently reads."
"Pratik Patel, 29 Redbud Rd, complained about various pieces of this legislation."
"Staci Berger, 233 Ellis Parkway, expressed her opposition to this ordinance stating it could have unintended consequences in the future."
Official responses (1 sentence): "Township Attorney Raj Goomer responded with clarification regarding key points of the ordinance."
"There being no further comments, the public portion was closed."
"Council President [Name] opened the meeting to in person attendees for comments."
Same format — 1-2 sentences per speaker, 1 sentence per response. Keep it brief.
"There being no further comments, the public portion was closed."

Then the adoption resolution:
"RESOLUTION offered by Councilmember [Name], seconded by Councilmember [Name], BE IT RESOLVED, by the Township Council of Piscataway Township, New Jersey, that AN ORDINANCE ENTITLED: [ORDINANCE TITLE IN ALL CAPS] was introduced on the [date] day of [month] [year] and had passed the first reading and was published on the [date] day of [month] [year]."

"NOW, THEREFORE, BE IT RESOLVED, that the aforesaid Ordinance, having had a second reading on [full date], be adopted, passed, and after passage, be published, together with a notice of the date of passage or approval, in the official newspaper."

"BE IT FURTHER RESOLVED that this Ordinance shall be assigned No. [year]-[number]."

"On roll call vote: Councilmembers [names], & [Council President Name] answered yes."
(List absent members if any: "Absent: Councilmember [Name].")

11. CONSENT AGENDA RESOLUTION:
Start with a resolution number, e.g. "RESOLUTION #26-[number]"

"RESOLUTION offered by Councilmember [Name], seconded by Councilmember [Name]."

"WHEREAS, the Revised General Ordinances of the Township of Piscataway permit the adoption of Resolutions, Motions or Proclamations by the Township Council of the Township of Piscataway as part of the Consent Agenda, upon certain conditions: and"

"WHEREAS, each of the following Resolutions, Motions or Proclamations to be presented before the Township Council at its [full date] Regular Meeting appear to have the unanimous approval of all members of the Township Council:"

Then list each consent agenda item:
"a. RESOLUTION — [description]."
"b. RESOLUTION — [description]."
etc.

"NOW, THEREFORE, BE IT RESOLVED by the Township Council of the Township of Piscataway that each of the foregoing Resolutions, Motions or Proclamations is hereby adopted."

"On roll call vote: Councilmembers [names], & [Council President Name] answered yes."

Then write out the FULL TEXT of each individual resolution (a, b, c, etc.) with complete WHEREAS/NOW THEREFORE language. Separate each resolution with a centered resolution number header on its own line:

RESOLUTION #26-[number]

"WHEREAS, the Township of Piscataway (the "Township") [description of need]; and
WHEREAS, [vendor name] has submitted [bid/proposal] in the amount of $[amount]; and
WHEREAS, [funding/authorization citation]; and
WHEREAS, funds are available pursuant to certification # [number];
NOW, THEREFORE, BE IT RESOLVED by the Township Council of the Township of Piscataway, County of Middlesex, State of New Jersey, that the appropriate municipal officials be and are hereby authorized to [action] to [vendor], in the amount not to exceed $[amount], subject to all bid specifications and contract documents."

For professional services:
"WHEREAS, such services are to be awarded as a professional service without competitive bidding pursuant to N.J.S.A. 40A:11-5(1)(a) of the Local Public Contracts Law; and"

For bond releases:
"WHEREAS, [party] has posted a [type] bond in connection with [project]; and
WHEREAS, the Township Engineer has inspected said project and has certified that all work has been completed in accordance with the approved plans and specifications;
NOW, THEREFORE, BE IT RESOLVED...that the [bond type] posted by [party] for [project] be and is hereby released..."

For each resolution, end with:
"BE IT FURTHER RESOLVED that the aforementioned recitals are incorporated herein as though fully set forth at length; and
BE IT FURTHER RESOLVED that a certified copy of this Resolution shall be forwarded to the Township Clerk, and any other interested parties."

12. DISBURSEMENTS (if mentioned in transcript):
Reference the monthly bill list summary, e.g.:
"The following are Disbursements for the months of [months] [year]."
(Do not try to reproduce the actual financial tables — just note that disbursements were presented.)

13. DISCUSSION ITEMS (if any):
Write as narrative paragraphs describing the discussion topic and any action taken.

14. ANNOUNCEMENTS & COMMENTS FROM OFFICIALS:
*** EACH ENTRY MUST BE EXACTLY ONE SHORT SENTENCE, MAX 30 WORDS. NO SECOND SENTENCE. ***
*** USE BULLET POINTS (•). DO NOT REPEAT CONTENT FROM ORDINANCE OR PUBLIC COMMENT SECTIONS. ***

This is a BRIEF topic log. Every entry follows this pattern from REAL Piscataway minutes:
• Councilmember Cahill remarked on the good and bad happening in the world, and reminded everyone to be kind to one another.
• Councilmember Carmichael thanked the Holmes Marshall Fire Company for their generosity in giving toys to those less fortunate.
• Councilmember Leibowitz thanked residents for their generosity and wished everyone a Happy Hanukkah.
• Councilmember Rashid congratulated the Wawa for opening and said she is excited for the Tesla charging station.
• Councilmember Uhrin congratulated the Pop Warner 10U cheerleading team for winning first place at Queen City.
• Mayor Wahler had no comments.
• Business Administrator Cozzarelli stated the Township expects to receive $5.2 million for solar credits and an EV charging station rebate.
• Township Attorney Goomer had no comments.
• Council President Espinosa thanked the Township Council, Mayor, staff, and Police Department for their support.

Cover each councilmember (alphabetically), then Mayor, Business Administrator, Township Attorney, Council President last.

15. AGENDA SESSION FOR NEXT MEETING:
"The Council considered the matters on the Agenda for the [next meeting date] [Regular Meeting / Reorganization]:"
Then list each item using bullet points (•), grouping by category if applicable:
• MAYOR'S APPOINTMENTS:
    ○ [appointment 1]
    ○ [appointment 2]
• APPOINTMENTS:
    ○ [appointment 1]
• [Other agenda items as bullet points]

16. OPEN TO PUBLIC — REMOTE ATTENDEES:
"OPEN TO PUBLIC — REMOTE ATTENDEES:"
*** MAXIMUM 1-2 SENTENCES PER SPEAKER. NO EXCEPTIONS. ***
*** USE BULLET POINTS (•) FOR EACH SPEAKER, WITH SUB-BULLETS (○) FOR OFFICIAL RESPONSES. ***

FORMAT (from real Piscataway minutes) — *** EVERY official response MUST start with ○ ***:
• Ed Marsh, 113 Wyckoff Ave, asked that the Council reconsider the time limits given to the public during public portions. He also asked why public officials' contact information and public meetings are no longer advertised in the newsletter.
    ○ Township Attorney Raj Goomer responded that the public officials' contact information does not appear in the newsletter because of Daniel's Law.
• Brian Rak, 1247 Brookside Rd, asked what happens to the emails that are sent to the council@piscatawaynj.org email address.
    ○ Councilmember Cahill and Township Attorney Raj Goomer responded that all emails get printed and given to each councilmember. This specific email was legal in nature, so Mr. Goomer and the individual spoke discussed the subject matter.

*** CRITICAL: When an official (Council President, Councilmember, Mayor, Township Attorney, Business Administrator) responds to a public speaker, their response line MUST begin with "    ○" (4 spaces then ○). NEVER write official responses as plain paragraphs in sections 16/17. ***

Close: "There being no further comments, this portion of the meeting was closed to the public."

17. OPEN TO PUBLIC — IN PERSON ATTENDEES:
"OPEN TO PUBLIC — IN PERSON ATTENDEES:"
Same bullet format — • for each speaker (1-2 sentences), ○ for each official response. No long summaries.
*** Remember: official responses MUST use ○ sub-bullets, not plain paragraphs. ***
Close: "There being no further comments, this portion of the meeting was closed to the public."

18. ADJOURNMENT:
"There being no further business to come before the council, the meeting was adjourned at [time] pm. Motion by Councilmember [Name], seconded by Councilmember [Name], carried unanimously."

19. SIGNATURE BLOCK:
Respectfully submitted,


Jennifer Johnson, Deputy Township Clerk

Accepted:


Council President

=== KEY FORMATTING RULES ===
- Page header format: "[Full Date] — Page [number]" (not actually needed in text output, but use it if paginating mentally)
- Resolution numbers: #26-[sequential number starting from where last meeting left off]
- Ordinance numbers: assigned at adoption, format [year]-[number]
- Roll call votes: "On roll call vote: Councilmembers [names], & [Council President] answered yes."
- When listing councilmembers, list alphabetically with Council President LAST, separated by commas and & before the last name
- All WHEREAS clauses end with "; and" except the last one before NOW THEREFORE which ends with ";"
- Use "the Township of Piscataway (the 'Township')" on first reference in each resolution, then "the Township" thereafter
- Do NOT skip or abbreviate resolutions — write out the FULL legal text for each one
- For amounts, always use the exact dollar figure: "in the amount not to exceed $[amount]"
- The minutes should be COMPREHENSIVE. Piscataway minutes are typically 15-20 pages. Do not cut corners.`;
}

function buildUserMessage(
  meeting: { meeting_type: string; meeting_date: string; video_url: string },
  transcript: string,
  chapters: string,
  agendaItems: DocketEntry[]
): string {
  let msg = `MEETING TYPE: ${meeting.meeting_type === "reorganization" ? "Reorganization" : "Council Meeting"}\n`;
  msg += `MEETING DATE: ${meeting.meeting_date}\n`;
  msg += `VIDEO LINK: ${meeting.video_url}\n\n`;

  if (chapters) {
    msg += `=== CHAPTER MARKERS (section boundaries) ===\n${chapters}\n\n`;
  }

  if (agendaItems.length > 0) {
    msg += `=== AGENDA ITEMS (${agendaItems.length} items) ===\n`;
    for (const item of agendaItems) {
      const fields = typeof item.extracted_fields === "string"
        ? JSON.parse(item.extracted_fields)
        : item.extracted_fields;
      msg += `\n--- Item #${item.id} ---\n`;
      msg += `Type: ${item.item_type}\n`;
      msg += `Department: ${item.department}\n`;
      msg += `Subject: ${item.email_subject}\n`;
      msg += `Summary: ${item.summary}\n`;
      if (fields.vendor_name) msg += `Vendor: ${fields.vendor_name}\n`;
      if (fields.vendor_address) msg += `Vendor Address: ${fields.vendor_address}\n`;
      if (fields.contract_amount) msg += `Amount: ${fields.contract_amount}\n`;
      if (fields.bid_number) msg += `Bid #: ${fields.bid_number}\n`;
      if (fields.state_contract_number) msg += `State Contract #: ${fields.state_contract_number}\n`;
      if (fields.statutory_citation) msg += `Statutory Citation: ${fields.statutory_citation}\n`;
      if (fields.block_lot) msg += `Block/Lot: ${fields.block_lot}\n`;
      if (fields.ordinance_section) msg += `Ordinance Section: ${fields.ordinance_section}\n`;
      if (fields.dollar_amounts) msg += `Dollar Amounts: ${JSON.stringify(fields.dollar_amounts)}\n`;
    }
    msg += `\n`;
  }

  // Truncate transcript if needed (Claude Sonnet has 200K context but let's be reasonable)
  const maxTranscript = 150000;
  const truncated = transcript.length > maxTranscript
    ? transcript.slice(0, maxTranscript) + "\n\n[TRANSCRIPT TRUNCATED]"
    : transcript;

  msg += `=== FULL MEETING TRANSCRIPT ===\n${truncated}`;

  return msg;
}

export async function generateMinutes(
  meeting: { meeting_type: string; meeting_date: string; video_url: string },
  transcript: string,
  chapters: string,
  agendaItems: DocketEntry[],
  transcriptSource: TranscriptSource = "youtube_captions"
): Promise<string> {
  const meetingType = meeting.meeting_type as "council" | "reorganization";
  const systemPrompt = buildSystemPrompt(meetingType, transcriptSource);
  const userMessage = buildUserMessage(meeting, transcript, chapters, agendaItems);

  const stream = getClient().messages.stream({
    model: "claude-sonnet-4-5-20250929",
    max_tokens: 64000,
    system: systemPrompt,
    messages: [
      {
        role: "user",
        content: `Please produce the official meeting minutes for this council meeting based on the transcript, chapter markers, and agenda items provided. Remember: Piscataway minutes are LONG and DETAILED — typically 15-20 pages. Include full WHEREAS/NOW THEREFORE text for every resolution and ordinance. Do not abbreviate.\n\n${userMessage}`,
      },
    ],
  });

  const response = await stream.finalMessage();

  const textBlock = response.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new Error("No text content in API response");
  }

  return textBlock.text;
}

// --- Auto-generation ---

// In-memory lock to prevent duplicate concurrent generations
const generatingSet = new Set<number>();

/**
 * Check if a meeting is ready for auto-generation and fire it off in the background.
 * Conditions: has video_url, no minutes yet, meeting date is in the past.
 * Non-blocking — logs errors but never throws.
 */
export function maybeAutoGenerateMinutes(meetingId: number): void {
  // Fire-and-forget async
  (async () => {
    try {
      if (generatingSet.has(meetingId)) return;

      const meeting = getMeeting(meetingId);
      if (!meeting) return;
      if (!meeting.video_url) return;
      if (meeting.minutes) return;

      // Only generate for past meetings
      const today = new Date().toISOString().split("T")[0];
      if (meeting.meeting_date > today) return;

      const agendaItems = getAgendaItemsForMeeting(meeting.meeting_date);

      generatingSet.add(meetingId);
      console.log(`[auto-minutes] Starting generation for meeting ${meetingId} (${meeting.meeting_date} ${meeting.meeting_type})`);

      const transcriptData = await fetchTranscriptData(meeting.video_url);
      if (!transcriptData.transcript || transcriptData.transcript.trim().length === 0) {
        console.log(`[auto-minutes] No transcript available for meeting ${meetingId}`);
        return;
      }

      const minutes = await generateMinutes(
        {
          meeting_type: meeting.meeting_type,
          meeting_date: meeting.meeting_date,
          video_url: meeting.video_url,
        },
        transcriptData.transcript,
        transcriptData.chapters,
        agendaItems,
        transcriptData.source
      );

      updateMeeting(meetingId, { minutes });
      console.log(`[auto-minutes] Minutes generated for meeting ${meetingId}`);

      // Analyze transcript for ordinance outcomes and update tracking
      await analyzeOrdinanceOutcomes(meeting.meeting_type, meeting.meeting_date, transcriptData.transcript, agendaItems);
    } catch (err) {
      console.error(`[auto-minutes] Failed for meeting ${meetingId}:`, err instanceof Error ? err.message : err);
    } finally {
      generatingSet.delete(meetingId);
    }
  })();
}

// --- Ordinance outcome analysis ---

interface OrdinanceOutcome {
  docket_id: number;
  outcome: "introduced" | "hearing_held" | "adopted" | "failed" | "tabled" | "amended" | "not_mentioned";
  vote_result?: string;  // e.g. "7-0", "6-1"
  hearing_date_set?: string; // next hearing date if mentioned
  notes?: string;
}

/**
 * After minutes are generated, analyze them to determine what happened
 * to each ordinance on the agenda, then update tracking accordingly.
 */
export async function analyzeOrdinanceOutcomes(
  meetingType: string,
  meetingDate: string,
  transcript: string,
  agendaItems: DocketEntry[]
): Promise<void> {
  const ordinances = agendaItems.filter(
    (item) => item.item_type === "ordinance_new" || item.item_type === "ordinance_amendment"
  );

  if (ordinances.length === 0) return;

  const ordinanceList = ordinances.map((o) => {
    const fields = safeParseJson(o.extracted_fields);
    return {
      docket_id: o.id,
      ordinance_number: fields?.ordinance_number ?? null,
      summary: o.summary ?? o.email_subject,
    };
  }).map((o) =>
    `- docket_id=${o.docket_id}, ordinance_number=${o.ordinance_number ?? "unknown"}, summary: ${o.summary}`
  ).join("\n");

  const prompt = `Analyze this Piscataway Township Council meeting transcript to determine what happened to each ordinance.

CONTEXT: Piscataway Township, NJ (Faulkner Act Mayor-Council). The transcript is from a speech-to-text system — names may be misspelled.

MEETING TYPE: ${meetingType === "reorganization" ? "Reorganization Meeting" : "Council Meeting (formal first readings with roll call votes, public hearings, and adoption votes)"}
MEETING DATE: ${meetingDate}

ORDINANCES ON AGENDA:
${ordinanceList}

TRANSCRIPT:
${transcript}

For each ordinance, determine the outcome by listening for:
- Motions ("I move to...", "motion to introduce", "motion to adopt")
- Seconds ("seconded by...")
- Roll call votes (individual "aye"/"nay" responses from council members)
- Procedural language ("passed on first reading", "public hearing is now open", "ordinance is adopted", "tabled", "laid on the table", "sent back to committee")
- The presiding officer's declarations ("the ordinance is adopted", "motion carries")

Respond with a JSON array:
[
  {
    "docket_id": <number>,
    "outcome": "<one of: introduced, hearing_held, adopted, failed, tabled, amended, not_mentioned>",
    "vote_result": "<e.g. '7-0' or '6-1' — count ayes vs nays from roll call, or null if no vote taken>",
    "notes": "<brief note, e.g. 'Passed first reading 7-0' or 'Public hearing held, 2 speakers, adopted 6-1 (Patil nay)' or 'Tabled at request of administration'>"
  }
]

Outcome meanings:
- "introduced": Ordinance was read by title and/or passed first reading vote
- "hearing_held": Public hearing was opened and closed but NOT adopted in this meeting
- "adopted": Ordinance passed final adoption vote (may include hearing in same meeting)
- "failed": Vote failed or ordinance was defeated
- "tabled": Ordinance was tabled / postponed / laid on table / sent back to committee
- "amended": Ordinance was substantially amended during hearing (process may restart)
- "not_mentioned": Cannot find this ordinance discussed in the transcript

IMPORTANT:
- At regular meetings, an ordinance may have BOTH a public hearing and adoption vote. If adopted, use "adopted".
- At reorganization meetings, ordinances are typically not the focus. If only discussed with no motion/vote, use "not_mentioned".
- Count actual roll call responses for vote_result, don't guess.

Return ONLY the JSON array, no other text.`;

  try {
    const response = await getClient().messages.create({
      model: "claude-sonnet-4-5-20250929",
      max_tokens: 2000,
      messages: [{ role: "user", content: prompt }],
    });

    const text = response.content.find((b) => b.type === "text");
    if (!text || text.type !== "text") return;

    // Extract JSON from response (may be wrapped in markdown code fences)
    const jsonMatch = text.text.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return;

    const outcomes: OrdinanceOutcome[] = JSON.parse(jsonMatch[0]);

    for (const outcome of outcomes) {
      if (outcome.outcome === "not_mentioned") continue;

      const tracking = getOrdinanceTracking(outcome.docket_id);
      const updates: Record<string, string | number | null> = {};

      switch (outcome.outcome) {
        case "introduced":
          if (!tracking?.introduction_date) {
            updates.introduction_date = meetingDate;
            const mtgLabel = meetingType === "reorganization" ? "Reorganization" : "Council Meeting";
            updates.introduction_meeting = `${mtgLabel} ${new Date(meetingDate + "T12:00:00").toLocaleDateString("en-US", { month: "numeric", day: "numeric", year: "numeric" })}`;
          }
          if (outcome.vote_result && !tracking?.adoption_vote) {
            // Store the introduction vote in hearing_notes for reference
            const existingNotes = tracking?.hearing_notes || "";
            const introNote = `First reading vote: ${outcome.vote_result}`;
            if (!existingNotes.includes(introNote)) {
              updates.hearing_notes = existingNotes ? `${existingNotes}\n${introNote}` : introNote;
            }
          }
          // Auto-suggest hearing date if not set
          if (!tracking?.hearing_date) {
            const nextRegular = getNextCouncilMeetingAfter(meetingDate, 10);
            if (nextRegular) {
              updates.hearing_date = nextRegular.meeting_date;
            }
          }
          break;

        case "hearing_held":
          if (!tracking?.hearing_date) {
            updates.hearing_date = meetingDate;
          }
          if (outcome.notes) {
            const existingNotes = tracking?.hearing_notes || "";
            if (!existingNotes.includes(outcome.notes)) {
              updates.hearing_notes = existingNotes ? `${existingNotes}\n${outcome.notes}` : outcome.notes;
            }
          }
          break;

        case "adopted":
          // Mark hearing if not already set
          if (!tracking?.hearing_date) {
            updates.hearing_date = meetingDate;
          }
          if (!tracking?.adoption_date) {
            updates.adoption_date = meetingDate;
            if (outcome.vote_result) {
              updates.adoption_vote = outcome.vote_result;
            }
            // Auto-calculate effective date
            if (!tracking?.is_emergency) {
              const d = new Date(meetingDate + "T12:00:00");
              d.setDate(d.getDate() + 20);
              updates.effective_date = d.toISOString().split("T")[0];
            }
          }
          break;

        case "failed":
          if (!tracking?.adoption_failed) {
            updates.adoption_failed = 1;
            updates.adoption_date = meetingDate;
            if (outcome.vote_result) {
              updates.adoption_vote = outcome.vote_result;
            }
          }
          break;

        case "tabled":
          if (outcome.notes) {
            const existingNotes = tracking?.clerk_notes || "";
            const tableNote = `Tabled on ${meetingDate}: ${outcome.notes}`;
            if (!existingNotes.includes("Tabled")) {
              updates.clerk_notes = existingNotes ? `${existingNotes}\n${tableNote}` : tableNote;
            }
          }
          break;

        case "amended":
          updates.hearing_amended = 1;
          if (outcome.notes) {
            const existingNotes = tracking?.hearing_notes || "";
            if (!existingNotes.includes("amended")) {
              updates.hearing_notes = existingNotes ? `${existingNotes}\nSubstantially amended — process restarts` : "Substantially amended — process restarts";
            }
          }
          break;
      }

      if (Object.keys(updates).length > 0) {
        upsertOrdinanceTracking(outcome.docket_id, updates);
        console.log(`[ordinance-tracking] Updated docket ${outcome.docket_id}: ${outcome.outcome}${outcome.vote_result ? ` (${outcome.vote_result})` : ""}`);
      }
    }
  } catch (err) {
    console.error("[ordinance-tracking] Failed to analyze outcomes:", err instanceof Error ? err.message : err);
  }
}

function safeParseJson(s: string | null | undefined): Record<string, unknown> | null {
  if (!s) return null;
  try { return JSON.parse(s); } catch { return null; }
}

/**
 * Scan all past meetings and trigger auto-generation for any that are ready.
 * Called on meetings page load to catch seeded data or manual DB changes.
 */
export function checkPendingMinutesGeneration(): void {
  const meetings = getMeetingsNeedingMinutes();
  for (const meeting of meetings) {
    maybeAutoGenerateMinutes(meeting.id);
  }
}

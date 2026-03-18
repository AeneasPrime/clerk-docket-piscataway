import { NextRequest, NextResponse } from "next/server";
import { getMeeting, getAgendaItemsForMeeting, updateMeeting } from "@/lib/db";
import { fetchTranscriptData, generateMinutes, analyzeOrdinanceOutcomes } from "@/lib/minutes-generator";

export const dynamic = "force-dynamic";
// Allow long-running minutes generation (up to 10 minutes)
export const maxDuration = 600;

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const meetingId = parseInt(id, 10);
    const meeting = getMeeting(meetingId);

    if (!meeting) {
      return NextResponse.json({ error: "Meeting not found" }, { status: 404 });
    }

    if (!meeting.video_url) {
      return NextResponse.json(
        { error: "Meeting has no video URL — cannot generate minutes without a recording" },
        { status: 400 }
      );
    }

    // Get agenda items for this meeting
    const agendaItems = getAgendaItemsForMeeting(meeting.meeting_date);

    // Check if transcript was provided in request body (for when YouTube blocks cloud IPs)
    let transcript = "";
    let chapters = "";
    try {
      const body = await request.json();
      if (body?.transcript) {
        transcript = body.transcript;
        chapters = body.chapters || "";
      }
    } catch {
      // No JSON body — will fetch from YouTube
    }

    // If no transcript provided, fetch from YouTube auto-captions
    if (!transcript) {
      const transcriptData = await fetchTranscriptData(meeting.video_url);
      transcript = transcriptData.transcript;
      chapters = transcriptData.chapters;
    }

    if (!transcript?.trim()) {
      return NextResponse.json(
        { error: `No YouTube auto-captions available for video. YouTube may be blocking requests from this server.` },
        { status: 400 }
      );
    }

    // Generate minutes via Claude
    const minutes = await generateMinutes(
      {
        meeting_type: meeting.meeting_type,
        meeting_date: meeting.meeting_date,
        video_url: meeting.video_url,
      },
      transcript,
      chapters,
      agendaItems
    );

    // Save the generated minutes
    updateMeeting(meetingId, { minutes });

    // Analyze transcript for ordinance outcomes and update tracking
    await analyzeOrdinanceOutcomes(meeting.meeting_type, meeting.meeting_date, transcript, agendaItems);

    const updated = getMeeting(meetingId);
    return NextResponse.json(updated);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("Minutes generation error:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

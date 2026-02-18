import { getMeetingByTypeAndDate, updateMeeting } from "./db";
import { maybeAutoGenerateMinutes } from "./minutes-generator";

// Piscataway Community TV YouTube channel
const YOUTUBE_CHANNEL_ID = "UClvOfAfDVKKd8T-becTCVow";
// Video title pattern: "Piscataway Township Council Meeting: January 20, 2026"
const COUNCIL_MEETING_RE = /Piscataway Township Council Meeting:\s*(.+)/i;
const REORGANIZATION_RE = /reorganization|swearing.?in/i;

interface YouTubeVideo {
  videoId: string;
  title: string;
  publishedAt: string;
}

/**
 * Parse meeting date from a YouTube title like "Piscataway Township Council Meeting: February 10, 2026"
 * Returns YYYY-MM-DD or null
 */
function parseDateFromTitle(title: string): string | null {
  const match = title.match(COUNCIL_MEETING_RE);
  if (!match) return null;

  const dateStr = match[1].trim();
  const parsed = new Date(dateStr + " 12:00:00");
  if (isNaN(parsed.getTime())) return null;

  const y = parsed.getFullYear();
  const m = String(parsed.getMonth() + 1).padStart(2, "0");
  const d = String(parsed.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function parseMeetingType(title: string): "council" | "reorganization" | null {
  if (REORGANIZATION_RE.test(title)) return "reorganization";
  if (COUNCIL_MEETING_RE.test(title)) return "council";
  return null;
}

/**
 * Fetch recent videos from YouTube Data API v3.
 * Requires YOUTUBE_API_KEY env var.
 */
async function fetchFromYouTubeAPI(): Promise<YouTubeVideo[]> {
  const apiKey = process.env.YOUTUBE_API_KEY;
  if (!apiKey) return [];

  // Search for council meeting videos from this channel
  const params = new URLSearchParams({
    part: "snippet",
    channelId: YOUTUBE_CHANNEL_ID,
    q: "Piscataway Township Council Meeting",
    type: "video",
    order: "date",
    maxResults: "25",
    key: apiKey,
  });

  const res = await fetch(`https://www.googleapis.com/youtube/v3/search?${params}`);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`YouTube API returned ${res.status}: ${body}`);
  }

  const data = await res.json();
  return (data.items ?? []).map((item: { id: { videoId: string }; snippet: { title: string; publishedAt: string } }) => ({
    videoId: item.id.videoId,
    title: item.snippet.title,
    publishedAt: item.snippet.publishedAt,
  }));
}

/**
 * Fallback: fetch from YouTube RSS feed (no API key needed, but limited to ~15 most recent videos).
 */
async function fetchFromYouTubeRSS(): Promise<YouTubeVideo[]> {
  const rssUrl = `https://www.youtube.com/feeds/videos.xml?channel_id=${YOUTUBE_CHANNEL_ID}`;
  const res = await fetch(rssUrl);
  if (!res.ok) {
    throw new Error(`YouTube RSS returned ${res.status}`);
  }

  const xml = await res.text();
  const videos: YouTubeVideo[] = [];

  // Simple XML parsing — extract <entry> blocks
  const entryRegex = /<entry>([\s\S]*?)<\/entry>/g;
  let entryMatch;
  while ((entryMatch = entryRegex.exec(xml)) !== null) {
    const entry = entryMatch[1];

    const videoIdMatch = entry.match(/<yt:videoId>([^<]+)<\/yt:videoId>/);
    const titleMatch = entry.match(/<title>([^<]+)<\/title>/);
    const publishedMatch = entry.match(/<published>([^<]+)<\/published>/);

    if (videoIdMatch && titleMatch) {
      videos.push({
        videoId: videoIdMatch[1],
        title: titleMatch[1],
        publishedAt: publishedMatch?.[1] ?? "",
      });
    }
  }

  return videos;
}

export async function syncVideosFromYouTube(): Promise<{
  matched: number;
  already_linked: number;
  unmatched: number;
}> {
  let matched = 0;
  let already_linked = 0;
  let unmatched = 0;

  try {
    // Try API first, fall back to RSS
    let videos: YouTubeVideo[];
    if (process.env.YOUTUBE_API_KEY) {
      videos = await fetchFromYouTubeAPI();
    } else {
      videos = await fetchFromYouTubeRSS();
    }

    for (const video of videos) {
      const meetingType = parseMeetingType(video.title);
      if (!meetingType) continue;

      const meetingDate = parseDateFromTitle(video.title);
      if (!meetingDate) continue;

      const videoUrl = `https://www.youtube.com/watch?v=${video.videoId}`;
      const meeting = getMeetingByTypeAndDate(meetingType, meetingDate);

      if (!meeting) {
        unmatched++;
        continue;
      }

      if (meeting.video_url) {
        already_linked++;
        continue;
      }

      updateMeeting(meeting.id, { video_url: videoUrl });
      maybeAutoGenerateMinutes(meeting.id);
      matched++;
      console.log(`[video-sync] Linked ${video.title} → meeting ${meeting.id}`);
    }
  } catch (err) {
    console.error("Video sync error:", err instanceof Error ? err.message : err);
  }

  return { matched, already_linked, unmatched };
}

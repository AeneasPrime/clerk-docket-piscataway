import { NextRequest, NextResponse } from "next/server";
import { ensureMeetingsGenerated } from "@/lib/db";
import { syncVideosFromYouTube } from "@/lib/video-sync";
import { checkPendingMinutesGeneration } from "@/lib/minutes-generator";

/**
 * Cron endpoint — call daily to auto-discover YouTube videos and generate minutes.
 * Secured with CRON_SECRET env var. If not set, the endpoint is open (for easy local testing).
 *
 * Usage:
 *   curl -X POST https://your-app.onrender.com/api/cron/sync \
 *     -H "Authorization: Bearer <CRON_SECRET>"
 */
export async function POST(request: NextRequest) {
  // Auth check
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const auth = request.headers.get("authorization");
    if (auth !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  try {
    ensureMeetingsGenerated();

    const syncResult = await syncVideosFromYouTube();
    console.log(`[cron] Video sync: ${syncResult.matched} new, ${syncResult.already_linked} existing, ${syncResult.unmatched} unmatched`);

    checkPendingMinutesGeneration();

    return NextResponse.json({
      ok: true,
      sync: syncResult,
      message: "Video sync complete. Minutes generation triggered for eligible meetings.",
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[cron] Sync error:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

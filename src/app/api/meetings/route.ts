import { NextRequest, NextResponse } from "next/server";
import { ensureMeetingsGenerated, ensureSeeded, getMeetings } from "@/lib/db";
import { syncVideosFromYouTube } from "@/lib/video-sync";
import { checkPendingMinutesGeneration } from "@/lib/minutes-generator";

export async function GET(request: NextRequest) {
  try {
    ensureSeeded();
    ensureMeetingsGenerated();

    // Auto-sync videos from YouTube (Piscataway Community TV)
    await syncVideosFromYouTube();

    // Check for any past meetings that need minutes generated
    checkPendingMinutesGeneration();

    const url = request.nextUrl;
    const filter = (url.searchParams.get("filter") ?? "all") as "upcoming" | "past" | "all";
    const limit = parseInt(url.searchParams.get("limit") ?? "30", 10);
    const offset = parseInt(url.searchParams.get("offset") ?? "0", 10);

    const result = getMeetings({ filter, limit, offset });
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const YT_CLIENT_VERSION = "20.10.38";
const YT_ANDROID_UA = `com.google.android.youtube/${YT_CLIENT_VERSION} (Linux; U; Android 14)`;
const YT_WEB_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_4) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/85.0.4183.83 Safari/537.36";

export async function GET() {
  const videoId = "bOdTgtjXnJ8";
  const results: Record<string, unknown> = {};

  // Test 1: Innertube with Android UA
  try {
    const res = await fetch("https://www.youtube.com/youtubei/v1/player?prettyPrint=false", {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": YT_ANDROID_UA },
      body: JSON.stringify({
        context: { client: { clientName: "ANDROID", clientVersion: YT_CLIENT_VERSION } },
        videoId,
      }),
    });
    const data = await res.json();
    const tracks = data?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
    results.innertube = {
      status: res.status,
      playability: data?.playabilityStatus?.status,
      playabilityReason: data?.playabilityStatus?.reason,
      trackCount: tracks?.length ?? 0,
    };

    if (tracks?.length > 0) {
      const enTrack = tracks.find((t: { languageCode: string }) => t.languageCode === "en");
      if (enTrack?.baseUrl) {
        // Try fetching captions with Android UA
        const capRes = await fetch(enTrack.baseUrl, { headers: { "User-Agent": YT_ANDROID_UA } });
        const xml = await capRes.text();
        results.captionFetchAndroid = { status: capRes.status, length: xml.length, first100: xml.slice(0, 100) };

        // Try with web UA
        const capRes2 = await fetch(enTrack.baseUrl, { headers: { "User-Agent": YT_WEB_UA } });
        const xml2 = await capRes2.text();
        results.captionFetchWeb = { status: capRes2.status, length: xml2.length };
      }
    }
  } catch (e) {
    results.innertube = { error: e instanceof Error ? e.message : String(e) };
  }

  // Test 2: Web page scrape
  try {
    const pageRes = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
      headers: { "User-Agent": YT_WEB_UA, "Accept-Language": "en-US,en;q=0.9" },
    });
    const html = await pageRes.text();
    results.scrape = {
      pageLength: html.length,
      hasRecaptcha: html.includes('class="g-recaptcha"'),
      hasPlayerResponse: html.includes("var ytInitialPlayerResponse"),
    };
  } catch (e) {
    results.scrape = { error: e instanceof Error ? e.message : String(e) };
  }

  return NextResponse.json(results);
}

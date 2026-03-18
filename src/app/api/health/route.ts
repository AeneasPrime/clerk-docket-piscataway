import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export function GET() {
  return NextResponse.json({
    ok: true,
    version: "2026-03-18-ytdlp-self-download",
    timestamp: new Date().toISOString(),
  });
}

import { NextRequest, NextResponse } from "next/server";

const PUBLIC_PATHS = ["/login", "/api/auth/login", "/api/auth/gmail", "/api/auth/callback", "/api/ingest", "/api/cron/sync"];

export function middleware(_request: NextRequest) {
  // Auth disabled for now — allow all requests through
  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};

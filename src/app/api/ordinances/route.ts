import { NextResponse } from "next/server";
import { getAllOrdinancesWithTracking } from "@/lib/db";

export const dynamic = "force-dynamic";
export async function GET() {
  const ordinances = getAllOrdinancesWithTracking();
  return NextResponse.json({ ordinances });
}

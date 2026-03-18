import { NextResponse } from "next/server";
import { exec } from "child_process";
import { promisify } from "util";
import { existsSync } from "fs";

const execAsync = promisify(exec);

export const dynamic = "force-dynamic";

export async function GET() {
  const results: Record<string, unknown> = {};

  results.ytdlpExists = existsSync("/tmp/yt-dlp");

  if (existsSync("/tmp/yt-dlp")) {
    try {
      const { stdout } = await execAsync("/tmp/yt-dlp --version 2>&1", { timeout: 10000 });
      results.version = stdout.trim();
    } catch {}

    // Get the FULL error output from caption fetch
    try {
      const { stdout, stderr } = await execAsync(
        '/tmp/yt-dlp --verbose --write-auto-sub --sub-lang en --sub-format vtt --skip-download ' +
        '--output "/tmp/debug-test" "https://www.youtube.com/watch?v=bOdTgtjXnJ8" 2>&1',
        { timeout: 60000, maxBuffer: 1024 * 1024 }
      );
      results.output = (stdout + (stderr || ""));
    } catch (e) {
      // The full error including stdout/stderr is in e.message or e.stdout/e.stderr
      const err = e as { stdout?: string; stderr?: string; message?: string };
      results.stdout = err.stdout || "";
      results.stderr = err.stderr || "";
      results.message = (err.message || "").slice(-3000);
    }
  }

  return NextResponse.json(results);
}

import { NextResponse } from "next/server";
import { exec } from "child_process";
import { promisify } from "util";
import { existsSync, statSync, chmodSync } from "fs";

const execAsync = promisify(exec);

export const dynamic = "force-dynamic";

export async function GET() {
  const results: Record<string, unknown> = {};

  // Check Python
  try {
    const { stdout } = await execAsync("python3 --version 2>&1", { timeout: 5000 });
    results.python = stdout.trim();
  } catch {}

  // Check /tmp/yt-dlp
  results.ytdlpExists = existsSync("/tmp/yt-dlp");

  // Download if needed
  if (!existsSync("/tmp/yt-dlp")) {
    try {
      const { stdout } = await execAsync(
        'curl -L -o /tmp/yt-dlp "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp" 2>&1',
        { timeout: 60000 }
      );
      results.curlOutput = stdout.slice(-500);
      if (existsSync("/tmp/yt-dlp")) {
        chmodSync("/tmp/yt-dlp", 0o755);
        results.downloadedSize = statSync("/tmp/yt-dlp").size;
      }
    } catch (e) {
      results.curlError = (e instanceof Error ? e.message : String(e)).slice(0, 500);
    }
  } else {
    results.existingSize = statSync("/tmp/yt-dlp").size;
  }

  // Run yt-dlp --version
  if (existsSync("/tmp/yt-dlp")) {
    try {
      const { stdout } = await execAsync("/tmp/yt-dlp --version 2>&1", { timeout: 10000 });
      results.ytdlpVersion = stdout.trim();
    } catch (e) {
      results.ytdlpVersionError = (e instanceof Error ? e.message : String(e)).slice(0, 500);
    }

    // Try caption fetch
    try {
      const { stdout } = await execAsync(
        '/tmp/yt-dlp --verbose --write-auto-sub --sub-lang en --sub-format vtt --skip-download ' +
        '--output "/tmp/debug-test" "https://www.youtube.com/watch?v=bOdTgtjXnJ8" 2>&1',
        { timeout: 60000 }
      );
      results.captionOutput = stdout.slice(-1500);
    } catch (e) {
      results.captionError = (e instanceof Error ? e.message : String(e)).slice(-1500);
    }
  }

  return NextResponse.json(results);
}

import { NextResponse } from "next/server";
import { exec } from "child_process";
import { promisify } from "util";
import { existsSync, statSync } from "fs";

const execAsync = promisify(exec);

export const dynamic = "force-dynamic";

export async function GET() {
  const results: Record<string, unknown> = {};

  // Check /data/yt-dlp (persistent disk)
  results.dataYtdlpExists = existsSync("/data/yt-dlp");
  if (existsSync("/data/yt-dlp")) {
    const stat = statSync("/data/yt-dlp");
    results.dataYtdlpSize = stat.size;
    results.dataYtdlpMode = stat.mode.toString(8);
  }

  // Try running /data/yt-dlp --version
  try {
    const { stdout } = await execAsync("/data/yt-dlp --version 2>&1", { timeout: 10000 });
    results.ytdlpVersion = stdout.trim();
  } catch (e) {
    results.ytdlpVersionError = (e instanceof Error ? e.message : String(e)).slice(0, 500);
  }

  // Check Python
  try {
    const { stdout } = await execAsync("python3 --version 2>&1", { timeout: 5000 });
    results.python = stdout.trim();
  } catch (e) {
    results.python = "error";
  }

  // List /data directory
  try {
    const { stdout } = await execAsync("ls -la /data/ 2>&1", { timeout: 5000 });
    results.dataDir = stdout.trim();
  } catch (e) {
    results.dataDir = "error";
  }

  // Try a yt-dlp caption fetch with verbose output
  if (existsSync("/data/yt-dlp")) {
    try {
      const { stdout, stderr } = await execAsync(
        '/data/yt-dlp --verbose --write-auto-sub --sub-lang en --sub-format vtt --skip-download ' +
        '--output "/tmp/debug-test" "https://www.youtube.com/watch?v=bOdTgtjXnJ8" 2>&1',
        { timeout: 60000 }
      );
      results.ytdlpOutput = (stdout + (stderr || "")).slice(-1000);
    } catch (e) {
      results.ytdlpError = (e instanceof Error ? e.message : String(e)).slice(-1000);
    }
  }

  return NextResponse.json(results);
}

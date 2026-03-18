import { NextResponse } from "next/server";
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

export const dynamic = "force-dynamic";

export async function GET() {
  const results: Record<string, unknown> = {};

  // Check if yt-dlp exists
  try {
    const { stdout: which } = await execAsync("which yt-dlp 2>&1 || echo 'not found'");
    results.ytdlpPath = which.trim();
  } catch (e) {
    results.ytdlpPath = "error: " + (e instanceof Error ? e.message : String(e));
  }

  // Check yt-dlp version
  try {
    const { stdout } = await execAsync("yt-dlp --version 2>&1", { timeout: 10000 });
    results.ytdlpVersion = stdout.trim();
  } catch (e) {
    results.ytdlpVersionError = (e instanceof Error ? e.message : String(e)).slice(0, 500);
  }

  // Check Python
  try {
    const { stdout } = await execAsync("python3 --version 2>&1 || python --version 2>&1 || echo 'no python'", { timeout: 5000 });
    results.python = stdout.trim();
  } catch (e) {
    results.python = "error: " + (e instanceof Error ? e.message : String(e));
  }

  // Try yt-dlp caption fetch
  try {
    const { stdout, stderr } = await execAsync(
      'yt-dlp --write-auto-sub --sub-lang en --sub-format vtt --skip-download ' +
      '--output "/tmp/debug-test" "https://www.youtube.com/watch?v=bOdTgtjXnJ8" 2>&1',
      { timeout: 30000 }
    );
    results.ytdlpOutput = (stdout + stderr).slice(-500);
  } catch (e) {
    results.ytdlpError = (e instanceof Error ? e.message : String(e)).slice(0, 500);
  }

  return NextResponse.json(results);
}

import { NextResponse } from "next/server";
import { exec } from "child_process";
import { promisify } from "util";
import { existsSync } from "fs";

const execAsync = promisify(exec);

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function GET() {
  const results: Record<string, unknown> = {};

  results.ytdlpExists = existsSync("/tmp/yt-dlp");

  // Find node
  try {
    const { stdout } = await execAsync("which node", { timeout: 5000 });
    results.nodePath = stdout.trim();
  } catch {}

  if (existsSync("/tmp/yt-dlp")) {
    try {
      const { stdout } = await execAsync("/tmp/yt-dlp --version 2>&1", { timeout: 10000 });
      results.version = stdout.trim();
    } catch {}

    // Try with --js-runtimes node
    const nodePath = (results.nodePath as string) || "node";
    try {
      const { stdout } = await execAsync(
        `/tmp/yt-dlp --verbose --js-runtimes node:${nodePath} --write-auto-sub --sub-lang en --sub-format vtt --skip-download ` +
        `--output "/tmp/debug-test" "https://www.youtube.com/watch?v=bOdTgtjXnJ8" 2>&1`,
        { timeout: 90000, maxBuffer: 1024 * 1024 }
      );
      results.output = stdout;
    } catch (e) {
      const err = e as { stdout?: string; stderr?: string; message?: string };
      results.stdout = err.stdout || "";
      results.stderr = err.stderr || "";
      results.message = (err.message || "").slice(-3000);
    }

    // Check if subtitle file was created
    results.subtitleCreated = existsSync("/tmp/debug-test.en.vtt");
  }

  return NextResponse.json(results);
}

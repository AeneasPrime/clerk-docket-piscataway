import { NextResponse } from "next/server";
import { exec } from "child_process";
import { promisify } from "util";
import { existsSync, statSync, writeFileSync, chmodSync } from "fs";

const execAsync = promisify(exec);

export const dynamic = "force-dynamic";

export async function GET() {
  const results: Record<string, unknown> = {};

  // Check /data directory
  results.dataExists = existsSync("/data");
  try {
    const { stdout } = await execAsync("ls -la /data/ 2>&1 | head -20", { timeout: 5000 });
    results.dataDir = stdout.trim();
  } catch (e) {
    results.dataDirError = (e instanceof Error ? e.message : String(e)).slice(0, 300);
  }

  // Check Python
  try {
    const { stdout } = await execAsync("python3 --version 2>&1", { timeout: 5000 });
    results.python = stdout.trim();
  } catch {}

  // Try downloading yt-dlp
  results.dataYtdlpExistsBefore = existsSync("/data/yt-dlp");

  if (!existsSync("/data/yt-dlp") && existsSync("/data")) {
    try {
      // Try curl first
      const { stdout, stderr } = await execAsync(
        'curl -L -o /data/yt-dlp "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp" 2>&1',
        { timeout: 60000 }
      );
      results.curlOutput = (stdout + (stderr || "")).slice(-500);
      if (existsSync("/data/yt-dlp")) {
        chmodSync("/data/yt-dlp", 0o755);
        results.downloadedSize = statSync("/data/yt-dlp").size;
      }
    } catch (e) {
      results.curlError = (e instanceof Error ? e.message : String(e)).slice(0, 500);

      // Fallback: try Node fetch
      try {
        const res = await fetch("https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp", { redirect: "follow" });
        results.fetchStatus = res.status;
        results.fetchHeaders = Object.fromEntries(res.headers.entries());
        if (res.ok && res.body) {
          const buf = await res.arrayBuffer();
          results.fetchSize = buf.byteLength;
          writeFileSync("/data/yt-dlp", Buffer.from(buf));
          chmodSync("/data/yt-dlp", 0o755);
        }
      } catch (fe) {
        results.fetchError = (fe instanceof Error ? fe.message : String(fe)).slice(0, 300);
      }
    }
  }

  results.dataYtdlpExistsAfter = existsSync("/data/yt-dlp");

  // Try running yt-dlp
  if (existsSync("/data/yt-dlp")) {
    try {
      const { stdout } = await execAsync("/data/yt-dlp --version 2>&1", { timeout: 10000 });
      results.ytdlpVersion = stdout.trim();
    } catch (e) {
      results.ytdlpRunError = (e instanceof Error ? e.message : String(e)).slice(0, 500);
    }

    // Try caption fetch with verbose
    try {
      const { stdout } = await execAsync(
        '/data/yt-dlp --verbose --write-auto-sub --sub-lang en --sub-format vtt --skip-download ' +
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

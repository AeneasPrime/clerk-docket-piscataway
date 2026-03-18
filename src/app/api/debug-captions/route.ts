import { NextResponse } from "next/server";
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

export const dynamic = "force-dynamic";

export async function GET() {
  const results: Record<string, unknown> = {};

  // Check PATH and home directory
  results.PATH = process.env.PATH;
  results.HOME = process.env.HOME;

  // Check if pip exists
  try {
    const { stdout } = await execAsync("which pip pip3 2>&1 || echo 'no pip'", { timeout: 5000 });
    results.pip = stdout.trim();
  } catch (e) {
    results.pip = "error: " + (e instanceof Error ? e.message : String(e));
  }

  // List ~/.local/bin contents
  try {
    const { stdout } = await execAsync("ls -la $HOME/.local/bin/ 2>&1 || echo 'dir not found'", { timeout: 5000 });
    results.localBin = stdout.trim();
  } catch (e) {
    results.localBin = "error: " + (e instanceof Error ? e.message : String(e));
  }

  // Check if yt-dlp exists
  try {
    const { stdout: which } = await execAsync("which yt-dlp 2>&1 || echo 'not found'");
    results.ytdlpPath = which.trim();
  } catch (e) {
    results.ytdlpPath = "error: " + (e instanceof Error ? e.message : String(e));
  }

  // Try running yt-dlp with full path
  try {
    const { stdout } = await execAsync("$HOME/.local/bin/yt-dlp --version 2>&1 || echo 'not at ~/.local/bin'", { timeout: 10000 });
    results.ytdlpVersionLocal = stdout.trim();
  } catch (e) {
    results.ytdlpVersionLocal = "error: " + (e instanceof Error ? e.message : String(e));
  }

  // Check Python
  try {
    const { stdout } = await execAsync("python3 --version 2>&1 || python --version 2>&1 || echo 'no python'", { timeout: 5000 });
    results.python = stdout.trim();
  } catch (e) {
    results.python = "error: " + (e instanceof Error ? e.message : String(e));
  }

  // Try pip install yt-dlp right now and see what happens
  try {
    const { stdout } = await execAsync("pip install yt-dlp 2>&1", { timeout: 60000 });
    results.pipInstall = stdout.trim().slice(-300);
  } catch (e) {
    results.pipInstall = "error: " + (e instanceof Error ? e.message : String(e)).slice(0, 500);
  }

  // Check again after install
  try {
    const { stdout } = await execAsync("$HOME/.local/bin/yt-dlp --version 2>&1 || which yt-dlp 2>&1 || echo 'still not found'", { timeout: 10000 });
    results.ytdlpAfterInstall = stdout.trim();
  } catch (e) {
    results.ytdlpAfterInstall = "error: " + (e instanceof Error ? e.message : String(e));
  }

  return NextResponse.json(results);
}

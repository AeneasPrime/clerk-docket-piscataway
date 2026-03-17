export async function register() {
  // Only run the scheduler on the server (not during build or edge runtime)
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const SYNC_INTERVAL_MS = 6 * 60 * 60 * 1000; // every 6 hours

    async function runSync() {
      try {
        const { ensureSeeded, ensureMeetingsGenerated } = await import("@/lib/db");
        const { syncVideosFromYouTube } = await import("@/lib/video-sync");
        const { checkPendingMinutesGeneration } = await import("@/lib/minutes-generator");
        const { classifyPendingEntries } = await import("@/lib/scanner");

        ensureSeeded();
        ensureMeetingsGenerated();

        const syncResult = await syncVideosFromYouTube();
        console.log(
          `[auto-sync] Video sync: ${syncResult.matched} new, ${syncResult.already_linked} existing, ${syncResult.unmatched} unmatched`
        );

        const classified = await classifyPendingEntries();
        if (classified > 0) {
          console.log(`[auto-sync] Classified ${classified} pending docket entries`);
        }

        checkPendingMinutesGeneration();
        console.log(`[auto-sync] Sync complete at ${new Date().toISOString()}`);
      } catch (err) {
        console.error("[auto-sync] Error:", err instanceof Error ? err.message : err);
      }
    }

    // Run once on startup (after a short delay to let the server initialize)
    setTimeout(() => {
      console.log("[auto-sync] Running initial sync...");
      runSync();
    }, 10_000);

    // Then run every 6 hours
    setInterval(() => {
      console.log("[auto-sync] Running scheduled sync...");
      runSync();
    }, SYNC_INTERVAL_MS);
  }
}

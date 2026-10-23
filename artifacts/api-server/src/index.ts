import app from "./app";
import { logger } from "./lib/logger";
import { loadRuntimeConfig } from "./lib/configStore";
import { startScheduler } from "./lib/scheduler";
import { startConfiguredHistoricalAudit } from "./lib/historicalAudit";
import { pool } from "@workspace/db";
import { drainBackgroundTasks, isShuttingDown, startTrackedJob } from "./lib/lifecycle";

await loadRuntimeConfig();
const port = Number(process.env.PORT || 8080);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid PORT");
let stopScheduler: (() => void) | undefined;
const server = app.listen(port, process.env.HOST || "0.0.0.0", () => {
  logger.info({ port }, "Server listening");
  if (process.env.RUN_SCHEDULER === "true") stopScheduler = startScheduler();
  if (process.env.AUTO_AUDIT_START_DATE) {
    const delayMs = Math.max(5_000, Number(process.env.AUTO_AUDIT_START_DELAY_MS || 45_000));
    setTimeout(() => {
      if (isShuttingDown()) return;
      void startTrackedJob(undefined, startConfiguredHistoricalAudit, async (error) => {
        logger.error(
          { error: error instanceof Error ? error.message : String(error) },
          "Configured historical audit failed",
        );
      });
    }, delayMs).unref();
  }
});
let stopping = false;
async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  logger.info({ signal }, "Shutdown started");
  // Render sends SIGKILL 30 s after SIGTERM by default; finish well before.
  setTimeout(() => process.exit(1), 27_000).unref();
  stopScheduler?.();
  server.close();
  const unfinished = await drainBackgroundTasks(20_000);
  if (unfinished.length) {
    // Only this process's jobs: another instance may be running its own.
    await pool.query(
      "UPDATE crawl_jobs SET status='interrupted', error=concat_ws(E'\\n', NULLIF(error,''), '종료 신호로 중단됨: 이 기간은 다시 수집해야 합니다.'), updated_at=now() WHERE id = ANY($1) AND status='running'",
      [unfinished],
    ).catch((error) => logger.error({ error: String(error) }, "Could not mark interrupted jobs"));
  }
  await pool.end().catch(() => {});
  process.exit(0);
}
for (const signal of ["SIGTERM", "SIGINT"] as const) process.once(signal, () => { void shutdown(signal); });

import app from "./app";
import { logger } from "./lib/logger";
import { db, crawlJobsTable } from "@workspace/db";
import { eq, and, lt } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";
import { runCrawlJob } from "./lib/crawlOrchestrator";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

// Recover stale running jobs on startup
async function recoverStaleJobs(): Promise<void> {
  try {
    const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);
    const stale = await db
      .update(crawlJobsTable)
      .set({ status: "error", error: "Job timed out — server was restarted" })
      .where(
        and(
          eq(crawlJobsTable.status, "running"),
          lt(crawlJobsTable.createdAt, tenMinutesAgo),
        ),
      )
      .returning({ id: crawlJobsTable.id });

    if (stale.length > 0) {
      logger.info({ count: stale.length }, "Recovered stale crawl jobs");
    }
  } catch (err) {
    logger.error({ err }, "Failed to recover stale jobs");
  }
}

// Schedule daily auto-crawl at midnight KST (= 15:00 UTC)
function scheduleMidnightCrawl(): void {
  const now = new Date();
  const nextRun = new Date();
  // Midnight KST = 15:00 UTC (KST = UTC+9)
  nextRun.setUTCHours(15, 0, 0, 0);
  if (nextRun.getTime() <= now.getTime()) {
    nextRun.setUTCDate(nextRun.getUTCDate() + 1);
  }
  const delayMs = nextRun.getTime() - now.getTime();

  logger.info(
    { nextRun: nextRun.toISOString(), delayHours: Math.round(delayMs / 3600000) },
    "Auto-crawl scheduled",
  );

  setTimeout(async () => {
    // Crawl yesterday
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const dateStr = yesterday.toISOString().split("T")[0];
    const jobId = uuidv4();

    logger.info({ jobId, date: dateStr }, "Auto-crawl starting (midnight KST)");

    try {
      await db.insert(crawlJobsTable).values({
        id: jobId,
        status: "running",
        collected: 0,
        duplicates: 0,
        total: 0,
        progress: 0,
        currentSource: "",
        error: "",
      });

      await runCrawlJob(jobId, dateStr, dateStr);
      logger.info({ jobId, date: dateStr }, "Auto-crawl complete");
    } catch (err) {
      logger.error({ err, jobId }, "Auto-crawl failed");
      await db
        .update(crawlJobsTable)
        .set({ status: "error", error: String(err) })
        .where(eq(crawlJobsTable.id, jobId))
        .catch(() => {});
    }

    // Schedule next day
    scheduleMidnightCrawl();
  }, delayMs);
}

recoverStaleJobs().then(() => {
  app.listen(port, (err) => {
    if (err) {
      logger.error({ err }, "Error listening on port");
      process.exit(1);
    }
    logger.info({ port }, "Server listening");
    scheduleMidnightCrawl();
  });
});

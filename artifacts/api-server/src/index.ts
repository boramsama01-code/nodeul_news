import app from "./app";
import { logger } from "./lib/logger";
import { db, crawlJobsTable, articlesTable } from "@workspace/db";
import { eq, and, lt, count } from "drizzle-orm";
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

// On startup: if DB is empty or last crawl was >23h ago, run a catch-up crawl
async function startupCrawlIfNeeded(): Promise<void> {
  try {
    const [{ total }] = await db.select({ total: count() }).from(articlesTable);
    const isEmpty = total === 0;

    // Find the most recent successful crawl job
    const [lastJob] = await db
      .select()
      .from(crawlJobsTable)
      .orderBy(crawlJobsTable.createdAt)
      .limit(1);

    const twentyThreeHoursAgo = new Date(Date.now() - 23 * 60 * 60 * 1000);
    const needsCrawl =
      isEmpty ||
      !lastJob ||
      lastJob.createdAt < twentyThreeHoursAgo;

    if (!needsCrawl) {
      logger.info({ total }, "DB has recent data, skipping startup crawl");
      return;
    }

    // Determine date range: if empty, crawl last 365 days; otherwise yesterday only
    const endDate = new Date();
    endDate.setDate(endDate.getDate() - 0);
    const startDate = new Date();
    if (isEmpty) {
      startDate.setDate(startDate.getDate() - 365);
      logger.info("DB is empty — running initial crawl for last 365 days");
    } else {
      startDate.setDate(startDate.getDate() - 1);
      logger.info("Running catch-up crawl for yesterday");
    }

    const startStr = startDate.toISOString().split("T")[0];
    const endStr = endDate.toISOString().split("T")[0];
    const jobId = uuidv4();

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

    // Fire and forget — don't block server startup
    runCrawlJob(jobId, startStr, endStr)
      .then(() => logger.info({ jobId, startStr, endStr }, "Startup crawl complete"))
      .catch((err) => {
        logger.error({ err, jobId }, "Startup crawl failed");
        db.update(crawlJobsTable)
          .set({ status: "error", error: String(err) })
          .where(eq(crawlJobsTable.id, jobId))
          .catch(() => {});
      });
  } catch (err) {
    logger.error({ err }, "startupCrawlIfNeeded failed");
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
    "Daily auto-crawl scheduled",
  );

  setTimeout(async () => {
    const today = new Date();
    const dateStr = today.toISOString().split("T")[0];
    const jobId = uuidv4();

    logger.info({ jobId, date: dateStr }, "Daily auto-crawl starting (midnight KST)");

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
      logger.info({ jobId, date: dateStr }, "Daily auto-crawl complete");
    } catch (err) {
      logger.error({ err, jobId }, "Daily auto-crawl failed");
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

recoverStaleJobs()
  .then(() => {
    app.listen(port, (err) => {
      if (err) {
        logger.error({ err }, "Error listening on port");
        process.exit(1);
      }
      logger.info({ port }, "Server listening");
      // Run startup crawl if needed (non-blocking)
      startupCrawlIfNeeded();
      // Schedule daily midnight crawl
      scheduleMidnightCrawl();
    });
  });

import app from "./app";
import { logger } from "./lib/logger";
import { db, crawlJobsTable } from "@workspace/db";
import { eq, and, lt } from "drizzle-orm";
import { sql } from "drizzle-orm";

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

recoverStaleJobs().then(() => {
  app.listen(port, (err) => {
    if (err) {
      logger.error({ err }, "Error listening on port");
      process.exit(1);
    }
    logger.info({ port }, "Server listening");
  });
});

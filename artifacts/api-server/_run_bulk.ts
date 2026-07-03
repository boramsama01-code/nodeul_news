
import { db, crawlJobsTable } from "@workspace/db";
import { runBulkCrawlJob } from "./src/lib/bulkCrawlOrchestrator";
import { randomUUID } from "crypto";

(async () => {
  const jobId = randomUUID();
  const startDate = "2026-01-01";
  const endDate = "2026-06-30";
  console.log("=== standalone bulk crawl 시작 ===");
  console.log("jobId:", jobId, "| 기간:", startDate, "~", endDate);

  await db.insert(crawlJobsTable).values({ id: jobId, status: "running" });

  const t0 = Date.now();
  try {
    await runBulkCrawlJob(jobId, startDate, endDate);
    const mins = ((Date.now() - t0) / 60000).toFixed(1);
    console.log("=== 크롤 완료 ===", mins, "분 소요");
  } catch (e) {
    console.error("크롤 실패:", e && e.message ? e.message : e);
    console.error(e && e.stack ? e.stack : "");
  }
  process.exit(0);
})();

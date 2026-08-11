import { Router, type IRouter } from "express";
import { v4 as uuidv4 } from "uuid";
import { db, crawlJobsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import {
  StartCrawlBody,
  StartBulkCrawlBody,
  GetCrawlStatusParams,
} from "@workspace/api-zod";
import { runCrawlJob } from "../lib/crawlOrchestrator";
import { runBulkCrawlJob } from "../lib/bulkCrawlOrchestrator";
import { logger } from "../lib/logger";

const router: IRouter = Router();

// POST /crawl/start
router.post("/crawl/start", async (req, res): Promise<void> => {
  const parsed = StartCrawlBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { startDate, endDate } = parsed.data;
  const jobId = uuidv4();

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
  } catch (err) {
    logger.error({ err, jobId }, "Unable to create crawl job");
    res.status(503).json({
      error: "수집 작업 저장소가 준비되지 않았습니다. 앱을 다시 게시해 데이터베이스 스키마를 동기화해 주세요.",
    });
    return;
  }

  // Fire and forget — do NOT await
  runCrawlJob(jobId, startDate, endDate).catch((err) => {
    logger.error({ err, jobId }, "Crawl job crashed");
    db.update(crawlJobsTable)
      .set({ status: "error", error: String(err) })
      .where(eq(crawlJobsTable.id, jobId))
      .catch(() => {});
  });

  res.json({ jobId });
});

// POST /crawl/bulk-start — month-by-month bulk crawl
router.post("/crawl/bulk-start", async (req, res): Promise<void> => {
  const parsed = StartBulkCrawlBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { startDate, endDate } = parsed.data;
  const jobId = uuidv4();

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
  } catch (err) {
    logger.error({ err, jobId }, "Unable to create bulk crawl job");
    res.status(503).json({
      error: "수집 작업 저장소가 준비되지 않았습니다. 앱을 다시 게시해 데이터베이스 스키마를 동기화해 주세요.",
    });
    return;
  }

  // Fire and forget — do NOT await
  runBulkCrawlJob(jobId, startDate, endDate).catch((err) => {
    logger.error({ err, jobId }, "Bulk crawl job crashed");
    db.update(crawlJobsTable)
      .set({ status: "error", error: String(err) })
      .where(eq(crawlJobsTable.id, jobId))
      .catch(() => {});
  });

  res.json({ jobId });
});

// GET /crawl/status/:jobId
router.get("/crawl/status/:jobId", async (req, res): Promise<void> => {
  const params = GetCrawlStatusParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [job] = await db
    .select()
    .from(crawlJobsTable)
    .where(eq(crawlJobsTable.id, params.data.jobId));

  if (!job) {
    res.status(404).json({ error: "Job not found" });
    return;
  }

  res.json({
    id: job.id,
    status: job.status,
    collected: job.collected,
    duplicates: job.duplicates,
    total: job.total,
    progress: job.progress,
    currentSource: job.currentSource,
    error: job.error,
    createdAt: job.createdAt.toISOString(),
  });
});

export default router;

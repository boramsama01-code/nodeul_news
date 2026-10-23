import {readProviderHealth} from "../lib/providerHealth";
import { Router, type IRouter } from "express";
import { v4 as uuidv4 } from "uuid";
import { db, crawlJobsTable } from "@workspace/db";
import { eq, desc } from "drizzle-orm";
import { validateCrawlSpan } from "../lib/crawlRuntime";
import {
  StartCrawlBody,
  StartBulkCrawlBody,
  GetCrawlStatusParams,
} from "@workspace/api-zod";
import { runCrawlJob } from "../lib/crawlOrchestrator";
import { runBulkCrawlJob } from "../lib/bulkCrawlOrchestrator";
import { logger } from "../lib/logger";
import { isShuttingDown, startTrackedJob } from "../lib/lifecycle";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { readRelevanceReviews } from "../lib/relevanceReview";
import { readState, usesDatabaseState } from "../lib/persistentState";
import { summarizeSourceHealth, type RssHealthItem } from "../lib/rssHealthAudit";

const router: IRouter = Router();
router.get("/crawl/relevance", async (req, res) => {
  try {
    const records = await readRelevanceReviews();
    const status = String(req.query.status || "pending");
    const page = Math.max(1, Number(req.query.page) || 1);
    const counts = {related: 0, unrelated: 0, pending: 0};
    for (const record of records) counts[record.decision.status]++;
    const selected = records.filter(r => r.decision.status === status).reverse();
    res.json({counts, total: selected.length, page, data: selected.slice((page - 1) * 30, page * 30).map(r => ({
      title: r.article.title, url: r.article.url, source: r.article.source, mediaName: r.article.mediaName,
      publishedAt: r.article.publishedAt, decision: r.decision, checkedAt: r.checkedAt, retryAt: r.retryAt, delivered: r.delivered,
    }))});
  } catch (err) { logger.error({err}, "Relevance journal read failed"); res.status(503).json({error: "관련성 확인 기록을 읽지 못했습니다."}); }
});
router.get("/crawl/provider-health", async (_req,res)=>{res.json(await readProviderHealth());});
router.get("/crawl/source-health", async (_req, res) => {
  try {
    if (usesDatabaseState()) {
      const report = await readState<{checkedAt:string;items:RssHealthItem[]}>("rss-health-audit-latest");
      // Support level comes from the feed loader, grouped per publisher.
      res.json({checkedAt:report?.checkedAt || null,...summarizeSourceHealth(report?.items || [])});
      return;
    }
    const report = JSON.parse(await readFile(join(process.env.DATA_DIR || ".local", "source-audit.json"), "utf8"));
    res.json(report);
  } catch { res.json({ checkedAt: null, sources: [] }); }
});
router.get("/crawl/recent", async (_req, res) => {
  const jobs = await db.select().from(crawlJobsTable).orderBy(desc(crawlJobsTable.createdAt)).limit(10);
  res.json(jobs);
});

// POST /crawl/start
router.post("/crawl/start", async (req, res): Promise<void> => {
  const parsed = StartCrawlBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  if (isShuttingDown()) { res.status(503).json({ error: "서버가 재시작 중입니다. 잠시 후 다시 시도해 주세요." }); return; }
  const { startDate, endDate } = parsed.data;
  try { validateCrawlSpan(startDate, endDate, 31); }
  catch (err) { res.status(400).json({ error: String(err) }); return; }
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

  // The job and its failure write are tracked together; shutdown waits for both.
  void startTrackedJob(jobId, () => runCrawlJob(jobId, startDate, endDate, {alternative:req.body.alternative===true, reviewOnly:req.body.reviewOnly===true}), async (err) => {
    logger.error({ err, jobId }, "Crawl job crashed");
    await db.update(crawlJobsTable)
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

  if (isShuttingDown()) { res.status(503).json({ error: "서버가 재시작 중입니다. 잠시 후 다시 시도해 주세요." }); return; }
  const { startDate, endDate } = parsed.data;
  try { validateCrawlSpan(startDate, endDate, 400); }
  catch (err) { res.status(400).json({ error: String(err) }); return; }
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

  void startTrackedJob(jobId, () => runBulkCrawlJob(jobId, startDate, endDate), async (err) => {
    logger.error({ err, jobId }, "Bulk crawl job crashed");
    await db.update(crawlJobsTable)
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

import { db, crawlJobsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { pool } from "@workspace/db";
import { runBulkCrawlJob } from "./bulkCrawlOrchestrator";
import { auditDirectRssFeeds } from "./rssHealthAudit";
import { backfillUnknownPublishers } from "./publisherResolver";
import { withCrawlLock } from "./crawlLock";
import { logger } from "./logger";
import { validateDateRange } from "./crawlRuntime";

function todayKst(): string {
  return new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
}

async function logCoverage(stage: string, startDate: string, endDate: string): Promise<void> {
  const result = await pool.query<{
    month: string;
    total: number;
    naver_web: number;
    naver_api: number;
    daum_web: number;
    google_rss: number;
    direct_rss: number;
    unknown: number;
  }>(
    `SELECT to_char(date_trunc('month', published_at AT TIME ZONE 'Asia/Seoul'),'YYYY-MM') AS month,
       count(*)::int AS total,
       count(*) FILTER (WHERE source='naver_web')::int AS naver_web,
       count(*) FILTER (WHERE source='naver_api')::int AS naver_api,
       count(*) FILTER (WHERE source='daum_web')::int AS daum_web,
       count(*) FILTER (WHERE source='google_news_rss')::int AS google_rss,
       count(*) FILTER (WHERE source='rss_direct')::int AS direct_rss,
       count(*) FILTER (WHERE media_name IN ('기타','알수없음','알 수 없음','네이버뉴스','다음뉴스','구글뉴스')
         OR media_name LIKE '%(기타)' OR media_name LIKE '%(알수없음)' OR media_name LIKE '%(알 수 없음)')::int AS unknown
     FROM articles
     WHERE deleted_at IS NULL AND published_at >= $1::date AND published_at < ($2::date + interval '1 day')
     GROUP BY 1 ORDER BY 1`,
    [startDate, endDate],
  );
  for (const row of result.rows) logger.info({ stage, ...row }, "Historical coverage month");

  const january = await pool.query(
    `SELECT count(*)::int AS total,
       count(*) FILTER (WHERE source='naver_web')::int AS naver_web,
       count(*) FILTER (WHERE source='naver_api')::int AS naver_api,
       count(*) FILTER (WHERE source='daum_web')::int AS daum_web,
       count(*) FILTER (WHERE source='google_news_rss')::int AS google_rss,
       count(*) FILTER (WHERE source='rss_direct')::int AS direct_rss,
       count(*) FILTER (WHERE media_name LIKE '%(기타)' OR media_name IN ('기타','알수없음','알 수 없음','네이버뉴스','다음뉴스','구글뉴스'))::int AS unknown
     FROM articles WHERE deleted_at IS NULL
       AND published_at >= '2026-01-01'::date AND published_at < '2026-01-15'::date`,
  );
  logger.info(
    { stage, period: "2026-01-01..2026-01-14", ...january.rows[0] },
    "Historical coverage focus period",
  );
}

export async function startConfiguredHistoricalAudit(): Promise<void> {
  const startDate = process.env.AUTO_AUDIT_START_DATE;
  if (!startDate) return;
  const endDate = process.env.AUTO_AUDIT_END_DATE || todayKst();
  validateDateRange(startDate, endDate);
  const jobId = process.env.AUTO_AUDIT_JOB_ID || `historical-audit-${startDate}-${endDate}-v1`;

  const [existing] = await db.select().from(crawlJobsTable).where(eq(crawlJobsTable.id, jobId));
  if (existing?.status === "done" && process.env.AUTO_AUDIT_FORCE !== "true") {
    logger.info({ jobId }, "Configured historical audit already completed");
    return;
  }

  const initial = {
    status: "running",
    progress: 0,
    collected: 0,
    duplicates: 0,
    total: 0,
    currentSource: "2026년 월별·7일 단위 재점검 준비 중…",
    error: "",
  };
  if (existing) await db.update(crawlJobsTable).set(initial).where(eq(crawlJobsTable.id, jobId));
  else await db.insert(crawlJobsTable).values({ id: jobId, ...initial });

  logger.info({ jobId, startDate, endDate }, "Configured historical audit started");
  await logCoverage("before", startDate, endDate);

  if (process.env.AUTO_RSS_HEALTH_AUDIT !== "false") {
    await db.update(crawlJobsTable).set({ currentSource: "직접 RSS를 소량 배치로 상태 점검 중…", progress: 2 })
      .where(eq(crawlJobsTable.id, jobId));
    await auditDirectRssFeeds();
  }

  await runBulkCrawlJob(jobId, startDate, endDate);
  const [bulkJob] = await db.select().from(crawlJobsTable).where(eq(crawlJobsTable.id, jobId));

  await db.update(crawlJobsTable).set({
    status: "running",
    progress: 96,
    currentSource: "원문 주소·og:site_name·JSON-LD publisher로 언론사명 보정 중…",
  }).where(eq(crawlJobsTable.id, jobId));

  const backfill = await withCrawlLock(
    () => backfillUnknownPublishers(startDate, endDate, { batchSize: 16, maxRows: 5000 }),
    jobId,
  );
  await logCoverage("after", startDate, endDate);

  const summary = `언론사명 보정: 확인 ${backfill.scanned}, 식별 ${backfill.resolved}, 미식별 ${backfill.unresolved}, 오류 ${backfill.errors}`;
  await db.update(crawlJobsTable).set({
    status: bulkJob?.status === "error" ? "error" : "done",
    progress: 100,
    currentSource: "",
    error: [bulkJob?.error, summary].filter(Boolean).join("\n"),
  }).where(eq(crawlJobsTable.id, jobId));

  logger.info({ jobId, backfill }, "Configured historical audit finished");
}

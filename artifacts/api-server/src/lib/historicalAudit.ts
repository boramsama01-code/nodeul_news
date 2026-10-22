import { db, crawlJobsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { pool } from "@workspace/db";
import { runBulkCrawlJob } from "./bulkCrawlOrchestrator";
import { auditDirectRssFeeds } from "./rssHealthAudit";
import { backfillUnknownPublishers } from "./publisherResolver";
import { withCrawlLock } from "./crawlLock";
import { sleepWithJitter } from "./crawlPacing";
import { logger } from "./logger";
import { validateDateRange } from "./crawlRuntime";
import { readState, writeState } from "./persistentState";

interface MonthRange {
  key: string;
  label: string;
  start: string;
  end: string;
}

interface HistoricalAuditProgress {
  version: 3;
  startDate: string;
  endDate: string;
  startedAt: string;
  updatedAt: string;
  finishedAt?: string;
  rssDone: boolean;
  crawledMonths: string[];
  publisherMonths: string[];
  failedCrawlMonths: Record<string, string>;
  failedPublisherMonths: Record<string, string>;
  crawlAttempts: Record<string, number>;
  collected: number;
  duplicates: number;
  publisherScanned: number;
  publisherResolved: number;
  publisherUnresolved: number;
  publisherErrors: number;
}

function todayKst(): string {
  return new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
}

function monthRanges(startDate: string, endDate: string): MonthRange[] {
  const [startYear, startMonth] = startDate.split("-").map(Number) as [number, number, number];
  const [endYear, endMonth] = endDate.split("-").map(Number) as [number, number, number];
  const ranges: MonthRange[] = [];
  let year = startYear;
  let month = startMonth;
  const pad = (value: number) => String(value).padStart(2, "0");

  while (year < endYear || (year === endYear && month <= endMonth)) {
    const key = `${year}-${pad(month)}`;
    const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
    const naturalStart = `${key}-01`;
    const naturalEnd = `${key}-${pad(lastDay)}`;
    ranges.push({
      key,
      label: `${year}년 ${month}월`,
      start: key === startDate.slice(0, 7) ? startDate : naturalStart,
      end: key === endDate.slice(0, 7) ? endDate : naturalEnd,
    });
    month++;
    if (month > 12) { month = 1; year++; }
  }
  return ranges;
}

function newProgress(startDate: string, endDate: string): HistoricalAuditProgress {
  const now = new Date().toISOString();
  return {
    version: 3,
    startDate,
    endDate,
    startedAt: now,
    updatedAt: now,
    rssDone: false,
    crawledMonths: [],
    publisherMonths: [],
    failedCrawlMonths: {},
    failedPublisherMonths: {},
    crawlAttempts: {},
    collected: 0,
    duplicates: 0,
    publisherScanned: 0,
    publisherResolved: 0,
    publisherUnresolved: 0,
    publisherErrors: 0,
  };
}

function validProgress(
  value: HistoricalAuditProgress | undefined,
  startDate: string,
  endDate: string,
): value is HistoricalAuditProgress {
  return value?.version === 3 && value.startDate === startDate && value.endDate === endDate;
}

async function saveProgress(key: string, progress: HistoricalAuditProgress): Promise<void> {
  progress.updatedAt = new Date().toISOString();
  await writeState(key, progress);
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

async function ensureJob(jobId: string, progress: HistoricalAuditProgress): Promise<void> {
  const [existing] = await db.select().from(crawlJobsTable).where(eq(crawlJobsTable.id, jobId));
  const initial = {
    status: "running",
    progress: 0,
    collected: progress.collected,
    duplicates: progress.duplicates,
    total: progress.collected + progress.duplicates,
    currentSource: "2026년 월별·7일 단위 재점검 준비 중…",
    error: "",
  };
  if (existing) await db.update(crawlJobsTable).set(initial).where(eq(crawlJobsTable.id, jobId));
  else await db.insert(crawlJobsTable).values({ id: jobId, ...initial });
}

export async function startConfiguredHistoricalAudit(): Promise<void> {
  const startDate = process.env.AUTO_AUDIT_START_DATE;
  if (!startDate) return;
  const endDate = process.env.AUTO_AUDIT_END_DATE || todayKst();
  validateDateRange(startDate, endDate);
  const jobId = process.env.AUTO_AUDIT_JOB_ID || `historical-audit-${startDate}-${endDate}-v3`;
  const stateKey = `historical-audit-progress:${jobId}`;
  const force = process.env.AUTO_AUDIT_FORCE === "true";
  const stored = force ? undefined : await readState<HistoricalAuditProgress>(stateKey);
  const progress = validProgress(stored, startDate, endDate) ? stored : newProgress(startDate, endDate);

  if (progress.finishedAt && !force) {
    logger.info({ jobId, finishedAt: progress.finishedAt }, "Configured historical audit already completed");
    return;
  }

  await ensureJob(jobId, progress);
  logger.info({ jobId, startDate, endDate, resumed: !!stored }, "Configured historical audit started");
  await logCoverage("before", startDate, endDate);
  const months = monthRanges(startDate, endDate);

  if (process.env.AUTO_RSS_HEALTH_AUDIT !== "false" && !progress.rssDone) {
    await db.update(crawlJobsTable).set({ currentSource: "직접 RSS를 소량 배치로 상태 점검 중…", progress: 2 })
      .where(eq(crawlJobsTable.id, jobId));
    await auditDirectRssFeeds();
    progress.rssDone = true;
    await saveProgress(stateKey, progress);
  }

  for (let pass = 1; pass <= 2; pass++) {
    const pending = months.filter((month) => !progress.crawledMonths.includes(month.key));
    if (pending.length === 0) break;

    for (const month of pending) {
      const ordinal = months.findIndex((entry) => entry.key === month.key);
      progress.crawlAttempts[month.key] = (progress.crawlAttempts[month.key] ?? 0) + 1;
      await db.update(crawlJobsTable).set({
        status: "running",
        progress: 5 + Math.floor((ordinal / Math.max(months.length, 1)) * 70),
        collected: progress.collected,
        duplicates: progress.duplicates,
        currentSource: `${month.label} 재점검 ${pass === 1 ? "" : "재시도 "}(7일 단위 순차 수집)…`,
        error: "",
      }).where(eq(crawlJobsTable.id, jobId));

      try {
        await runBulkCrawlJob(jobId, month.start, month.end);
        const [monthJob] = await db.select().from(crawlJobsTable).where(eq(crawlJobsTable.id, jobId));
        if (monthJob?.status === "done") {
          if (!progress.crawledMonths.includes(month.key)) {
            progress.crawledMonths.push(month.key);
            progress.collected += monthJob.collected ?? 0;
            progress.duplicates += monthJob.duplicates ?? 0;
          }
          delete progress.failedCrawlMonths[month.key];
        } else {
          progress.failedCrawlMonths[month.key] = monthJob?.error || "월별 수집이 부분 실패했습니다.";
        }
      } catch (error) {
        progress.failedCrawlMonths[month.key] = error instanceof Error ? error.message : String(error);
        logger.error({ jobId, month: month.key, error: progress.failedCrawlMonths[month.key] }, "Historical month crawl failed");
      }

      await saveProgress(stateKey, progress);
      await logCoverage(`after-crawl-${month.key}`, month.start, month.end);
      await sleepWithJitter(pass === 1 ? 9000 : 15000, pass === 1 ? 13000 : 22000);
    }
  }

  for (const month of months) {
    if (progress.publisherMonths.includes(month.key)) continue;
    const ordinal = months.findIndex((entry) => entry.key === month.key);
    await db.update(crawlJobsTable).set({
      status: "running",
      progress: 78 + Math.floor((ordinal / Math.max(months.length, 1)) * 20),
      collected: progress.collected,
      duplicates: progress.duplicates,
      currentSource: `${month.label} 원문 주소·og:site_name·JSON-LD publisher 보정 중…`,
    }).where(eq(crawlJobsTable.id, jobId));

    try {
      const backfill = await withCrawlLock(
        () => backfillUnknownPublishers(month.start, month.end, { batchSize: 16, maxRows: 1500 }),
        jobId,
      );
      progress.publisherScanned += backfill.scanned;
      progress.publisherResolved += backfill.resolved;
      progress.publisherUnresolved += backfill.unresolved;
      progress.publisherErrors += backfill.errors;
      progress.publisherMonths.push(month.key);
      delete progress.failedPublisherMonths[month.key];
    } catch (error) {
      progress.failedPublisherMonths[month.key] = error instanceof Error ? error.message : String(error);
      logger.error({ jobId, month: month.key, error: progress.failedPublisherMonths[month.key] }, "Historical publisher backfill failed");
    }
    await saveProgress(stateKey, progress);
    await sleepWithJitter(5000, 9000);
  }

  await logCoverage("after", startDate, endDate);
  const incompleteCrawls = months.filter((month) => !progress.crawledMonths.includes(month.key)).map((month) => month.key);
  const incompletePublishers = months.filter((month) => !progress.publisherMonths.includes(month.key)).map((month) => month.key);
  const complete = incompleteCrawls.length === 0 && incompletePublishers.length === 0;
  if (complete) {
    progress.finishedAt = new Date().toISOString();
    await saveProgress(stateKey, progress);
  }

  const summary = [
    `월별 수집 완료 ${progress.crawledMonths.length}/${months.length}`,
    `언론사명 보정 완료 ${progress.publisherMonths.length}/${months.length}`,
    `신규 ${progress.collected}, 중복 ${progress.duplicates}`,
    `언론사명 확인 ${progress.publisherScanned}, 식별 ${progress.publisherResolved}, 미식별 ${progress.publisherUnresolved}, 오류 ${progress.publisherErrors}`,
    incompleteCrawls.length ? `재시도 필요 월: ${incompleteCrawls.join(", ")}` : "",
    incompletePublishers.length ? `언론사 보정 재시도 필요 월: ${incompletePublishers.join(", ")}` : "",
  ].filter(Boolean).join("\n");

  await db.update(crawlJobsTable).set({
    status: complete ? "done" : "error",
    progress: 100,
    collected: progress.collected,
    duplicates: progress.duplicates,
    total: progress.collected + progress.duplicates,
    currentSource: "",
    error: summary,
  }).where(eq(crawlJobsTable.id, jobId));

  logger.info({ jobId, complete, progress, summary }, "Configured historical audit finished");
}

import { crawlAllSourcesPaced } from "./pacedSources";
import { crawlDateChunks, settleSequentially } from "./crawlPacing";
import { createRelevanceReview } from "./relevanceReview";
import { loadExistingArticles } from "./existingArticles";
import { db } from "@workspace/db";
import { articlesTable, crawlJobsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { withCrawlLock } from "./crawlLock";
import { crawlWarnings, decideJobStatus, validateDateRange, warnSource } from "./crawlRuntime";
import { logger } from "./logger";
import {
  isValidUrl,
  ArticleData,
} from "./crawlerUtils";
import { analyzeArticleSentiment } from "./aiAnalysis";
import { crawlAllSources, crawlNaverNews, crawlDaumNews, crawlNaverWebSearch } from "./crawlerSources";
import { enrichArticles } from "./publisherResolver";
import { withBulkFeedCache } from "./rssFeedCache";
import { withGoogleRssPolicy } from "./googleRssPolicy";

export interface BulkCrawlJobDependencies {
  db?: typeof db;
  analyzeArticleSentiment?: typeof analyzeArticleSentiment;
  crawlAllSources?: typeof crawlAllSources;
  crawlNaverNews?: typeof crawlNaverNews;
  crawlDaumNews?: typeof crawlDaumNews;
  crawlNaverWebSearch?: typeof crawlNaverWebSearch;
  enrichArticles?: typeof enrichArticles;
  createRelevanceReview?: typeof createRelevanceReview;
}

// Return "YYYY-MM-DD" strings for each month boundary (no timezone conversion here;
// crawlerSources applies KST internally when it parses these strings).
function getMonthRanges(
  startDate: string,
  endDate: string,
): Array<{ start: string; end: string; label: string }> {
  const ranges: Array<{ start: string; end: string; label: string }> = [];
  const start = new Date(startDate + "T00:00:00");
  const end   = new Date(endDate   + "T00:00:00");

  let current = new Date(start.getFullYear(), start.getMonth(), 1);

  while (current <= end) {
    const monthStart = new Date(current);
    const monthEnd   = new Date(current.getFullYear(), current.getMonth() + 1, 0);

    const rangeStart = monthStart < start ? start : monthStart;
    const rangeEnd   = monthEnd   > end   ? end   : monthEnd;

    const label = `${current.getFullYear()}년 ${current.getMonth() + 1}월`;

    const fmt = (d: Date) =>
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

    ranges.push({ start: fmt(rangeStart), end: fmt(rangeEnd), label });

    current = new Date(current.getFullYear(), current.getMonth() + 1, 1);
  }

  return ranges;
}

export async function runBulkCrawlJob(
  jobId: string,
  startDate: string,
  endDate: string,
  dependencies: BulkCrawlJobDependencies = {},
): Promise<void> {
  validateDateRange(startDate, endDate);
  const run = () => withGoogleRssPolicy(() => withBulkFeedCache(() =>
    crawlWarnings.run([], () => executeBulkCrawlJob(jobId, startDate, endDate, dependencies))));
  return dependencies.db ? run() : withCrawlLock(run, jobId);
}

async function executeBulkCrawlJob(
  jobId: string,
  startDate: string,
  endDate: string,
  dependencies: BulkCrawlJobDependencies = {},
): Promise<void> {
  const months = getMonthRanges(startDate, endDate);
  const totalMonths = months.length;

  logger.info({ jobId, totalMonths, startDate, endDate }, "Starting bulk crawl");

  const database = dependencies.db ?? db;
  const analyze = dependencies.analyzeArticleSentiment ?? analyzeArticleSentiment;
  const crawlSources = {
    all: dependencies.crawlAllSources ?? crawlAllSourcesPaced,
    naver: dependencies.crawlNaverNews ?? crawlNaverNews,
    daum: dependencies.crawlDaumNews ?? crawlDaumNews,
    naverWeb: dependencies.crawlNaverWebSearch ?? crawlNaverWebSearch,
  };
  const existingArticles = await loadExistingArticles(database);
  const review = await (dependencies.createRelevanceReview || createRelevanceReview)(dependencies.db ? {directory: false, maxRequests: 0} : {});
  const sentimentCache = new Map<string, Promise<boolean>>();
  let totalCollected = 0;
  let totalDuplicates = 0;
  let totalRefreshed = 0;
  let insertFailures = 0;
  let candidates = 0;
  const monthSummaries: string[] = [];

  const getSentiment = (article: ArticleData): Promise<boolean> => {
    const key = `${article.title}\u0000${article.content}`;
    const cached = sentimentCache.get(key);
    if (cached) return cached;

    const analysis = analyze(article.title, article.content);
    sentimentCache.set(key, analysis);
    return analysis;
  };

  for (let i = 0; i < months.length; i++) {
    const month = months[i]!;
    const monthProgress = Math.round((i / totalMonths) * 90);

    await database
      .update(crawlJobsTable)
      .set({
        currentSource: `[${i + 1}/${totalMonths}] ${month.label} 수집 중…`,
        progress: monthProgress,
        collected: totalCollected,
        duplicates: totalDuplicates,
      })
      .where(eq(crawlJobsTable.id, jobId));

    logger.info({ jobId, month: month.label, start: month.start, end: month.end }, "Bulk crawl: processing month");

    const [naverApiRes, naverWebRes, daumRes, rssRes] = await settleSequentially([
      async () => [] as ArticleData[], // naver_api 제외: start<=1000 제약으로 과거 수집 불가, naver_web으로 대체
      () => dependencies.db ? crawlSources.naverWeb(month.start, month.end) : crawlDateChunks("네이버 웹", crawlSources.naverWeb, month.start, month.end),
      () => dependencies.db ? crawlSources.daum(month.start, month.end) : crawlDateChunks("다음", crawlSources.daum, month.start, month.end),
      () => crawlSources.all(month.start, month.end),
    ], dependencies.db ? 0 : 2000);

    const naverApiResults = naverApiRes.status === "fulfilled" ? naverApiRes.value : [];
    const naverWebResults = naverWebRes.status === "fulfilled" ? naverWebRes.value : [];
    const daumResults     = daumRes.status     === "fulfilled" ? daumRes.value     : [];
    const rssResults      = rssRes.status      === "fulfilled" ? rssRes.value      : [];

    if (naverApiRes.status === "rejected") logger.error({ err: naverApiRes.reason, jobId, month: month.label }, "Naver API crawl failed for month");
    if (naverWebRes.status === "rejected") logger.error({ err: naverWebRes.reason, jobId, month: month.label }, "Naver web crawl failed for month");
    if (daumRes.status     === "rejected") logger.error({ err: daumRes.reason,     jobId, month: month.label }, "Daum crawl failed for month");
    if (rssRes.status      === "rejected") logger.error({ err: rssRes.reason,      jobId, month: month.label }, "RSS crawl failed for month");

    const rawArticles: ArticleData[] = [...review.retryCandidates(month.start, month.end), ...naverApiResults, ...naverWebResults, ...daumResults, ...rssResults];
    const enrich = dependencies.enrichArticles ?? (dependencies.db ? async (items: ArticleData[]) => items : enrichArticles);
    const articles = await enrich(rawArticles, { maxRequests: 180 });
    candidates += articles.length;
    monthSummaries.push(`${month.label}: 네이버웹 ${naverWebResults.length}, 다음 ${daumResults.length}, RSS·자체검색 ${rssResults.length}`);
    for (const [source, result] of [["네이버 웹", naverWebRes], ["다음", daumRes], ["RSS", rssRes]] as const) {
      if (result.status === "rejected") warnSource(source, `${month.label} 수집 실패`);
    }

    logger.info({ jobId, month: month.label, naverApi: naverApiResults.length, naverWeb: naverWebResults.length, daum: daumResults.length, rss: rssResults.length, count: articles.length }, "Bulk crawl: deduplicating month");

    for (const [articleIndex, candidate] of articles.entries()) {
      let article = candidate;
      if (!isValidUrl(article.url) || !Number.isFinite(article.publishedAt.getTime())) continue;
      const reviewExisting = existingArticles.needsReview(article);
      if (reviewExisting) article = (await review.assess(article)).article;
      try { if (await existingArticles.refresh(article)) { totalRefreshed++; await review.delivered(article); continue; } }
      catch (err) { insertFailures++; logger.error({err}, "Failed to refresh existing article"); continue; }
      if (await existingArticles.duplicate(article, rawArticles[articleIndex]?.url)) {
        totalDuplicates++;
        if (!reviewExisting) await review.delivered(article);
        continue;
      }

      const assessed = await review.assess(article);
      if (assessed.decision.status !== "related") continue;
      article = assessed.article;
      const isNegative = await getSentiment(article);

      try {
        await database.insert(articlesTable).values({
          title: article.title,
          content: article.content,
          url: article.url,
          publishedAt: article.publishedAt,
          mediaName: article.mediaName,
          isNegative,
          isSelfPR: article.isSelfPR,
          source: article.source,
        });
        totalCollected++;
        existingArticles.remember(article);
        await review.delivered(article);
      } catch (err: unknown) {
        const error = err as { code?: string; cause?: { code?: string } };
        const code = error.code ?? error.cause?.code;
        if (code === "23505" || code === "P2002") {
          totalDuplicates++;
        } else {
          insertFailures++;
          logger.error({ err }, "Failed to insert article");
        }
      }
    }

    // Preserve the actual collection source; do not synthesize publisher rows.

    const progressAfterMonth = Math.round(((i + 1) / totalMonths) * 90);
    await database
      .update(crawlJobsTable)
      .set({
        collected: totalCollected,
        duplicates: totalDuplicates,
        progress: progressAfterMonth,
        total: totalCollected + totalDuplicates + totalRefreshed,
      })
      .where(eq(crawlJobsTable.id, jobId));

    // 월 간 지연: 네이버 rate limit 회복 (연속 요청 누적 차단 방지)
    if (i < months.length - 1) {
      await new Promise((r) => setTimeout(r, 5000));
    }
  }

  await review.flush().catch(() => {});
  const pending = review.pendingCount?.() ?? 0;
  if (pending > 0) warnSource("원문 확인", `관련성 확인 대기 ${pending}건: 저장되지 않음`);
  await database
    .update(crawlJobsTable)
    .set({
      status: decideJobStatus({ insertFailures, candidates, warnings: crawlWarnings.getStore() ?? [] }),
      progress: 100,
      currentSource: "",
      total: totalCollected + totalDuplicates + totalRefreshed,
      collected: totalCollected,
      duplicates: totalDuplicates,
      error: [`수집 기간 ${startDate} ~ ${endDate}`, `후보 ${candidates}, 저장 실패 ${insertFailures}`, review.summary(), ...monthSummaries, existingArticles.summary(), ...(crawlWarnings.getStore() ?? [])].join("\n"),
    })
    .where(eq(crawlJobsTable.id, jobId));

  logger.info({ jobId, totalCollected, totalDuplicates, totalRefreshed, totalMonths }, "Bulk crawl job complete");
}

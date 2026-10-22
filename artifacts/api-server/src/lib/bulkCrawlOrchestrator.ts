import { db } from "@workspace/db";
import { articlesTable, crawlJobsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { withCrawlLock } from "./crawlLock";
import { crawlWarnings, validateDateRange, warnSource } from "./crawlRuntime";
import { logger } from "./logger";
import {
  isRelevant,
  isDuplicate,
  addToSet,
  isValidUrl,
  ArticleData,
} from "./crawlerUtils";
import { analyzeArticleSentiment } from "./aiAnalysis";
import { crawlAllSources, crawlNaverNews, crawlDaumNews, crawlNaverWebSearch } from "./crawlerSources";
import { crawlAllSourcesPaced } from "./pacedSources";
import { crawlDateChunks, sleepWithJitter } from "./crawlPacing";
import { enrichArticlePublisher } from "./publisherResolver";
import { loadExistingArticles, refreshExcludedArticle } from "./existingArticles";
import { withBulkFeedCache } from "./rssFeedCache";
import { withGoogleRssPolicy } from "./googleRssPolicy";

export interface BulkCrawlJobDependencies {
  db?: typeof db;
  analyzeArticleSentiment?: typeof analyzeArticleSentiment;
  crawlAllSources?: typeof crawlAllSources;
  crawlNaverNews?: typeof crawlNaverNews;
  crawlDaumNews?: typeof crawlDaumNews;
  crawlNaverWebSearch?: typeof crawlNaverWebSearch;
}

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

async function settle<T>(task: () => Promise<T>): Promise<PromiseSettledResult<T>> {
  try { return { status: "fulfilled", value: await task() }; }
  catch (reason) { return { status: "rejected", reason }; }
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
  logger.info({ jobId, totalMonths, startDate, endDate }, "Starting paced bulk crawl");

  const database = dependencies.db ?? db;
  const analyze = dependencies.analyzeArticleSentiment ?? analyzeArticleSentiment;
  const crawlSources = {
    all: dependencies.crawlAllSources ?? crawlAllSourcesPaced,
    naver: dependencies.crawlNaverNews ?? crawlNaverNews,
    daum: dependencies.crawlDaumNews ?? crawlDaumNews,
    naverWeb: dependencies.crawlNaverWebSearch ?? crawlNaverWebSearch,
  };
  const existing = await loadExistingArticles(database);
  const { existingSet } = existing;
  const sentimentCache = new Map<string, Promise<boolean>>();
  let totalCollected = 0;
  let totalDuplicates = 0;
  let totalRefreshed = 0;
  let insertFailures = 0;
  let candidates = 0;

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

    await database.update(crawlJobsTable).set({
      currentSource: `[${i + 1}/${totalMonths}] ${month.label}: 7일 단위 순차 수집 중…`,
      progress: monthProgress,
      collected: totalCollected,
      duplicates: totalDuplicates,
    }).where(eq(crawlJobsTable.id, jobId));

    logger.info({ jobId, month: month.label, start: month.start, end: month.end }, "Bulk crawl: processing month");

    const naverApiRes = { status: "fulfilled", value: [] } as PromiseFulfilledResult<ArticleData[]>;
    const naverWebRes = await settle(() => dependencies.crawlNaverWebSearch
      ? crawlSources.naverWeb(month.start, month.end)
      : crawlDateChunks("네이버 웹", crawlSources.naverWeb, month.start, month.end, {
          days: 7, pauseMinMs: 2400, pauseMaxMs: 4400,
        }));
    if (!dependencies.db) await sleepWithJitter(3000, 5200);

    const daumRes = await settle(() => dependencies.crawlDaumNews
      ? crawlSources.daum(month.start, month.end)
      : crawlDateChunks("다음 웹", crawlSources.daum, month.start, month.end, {
          days: 7, pauseMinMs: 2400, pauseMaxMs: 4400,
        }));
    if (!dependencies.db) await sleepWithJitter(3000, 5200);

    const rssRes = await settle(() => crawlSources.all(month.start, month.end));

    const naverApiResults = naverApiRes.value;
    const naverWebResults = naverWebRes.status === "fulfilled" ? naverWebRes.value : [];
    const daumResults     = daumRes.status     === "fulfilled" ? daumRes.value     : [];
    const rssResults      = rssRes.status      === "fulfilled" ? rssRes.value      : [];

    if (naverWebRes.status === "rejected") logger.error({ err: naverWebRes.reason, jobId, month: month.label }, "Naver web crawl failed for month");
    if (daumRes.status     === "rejected") logger.error({ err: daumRes.reason,     jobId, month: month.label }, "Daum crawl failed for month");
    if (rssRes.status      === "rejected") logger.error({ err: rssRes.reason,      jobId, month: month.label }, "RSS crawl failed for month");

    const articles: ArticleData[] = [...naverApiResults, ...naverWebResults, ...daumResults, ...rssResults];
    candidates += articles.length;
    for (const [source, result] of [["네이버 웹", naverWebRes], ["다음", daumRes], ["RSS·구글", rssRes]] as const) {
      if (result.status === "rejected") warnSource(source, `${month.label} 수집 실패`);
    }

    logger.info({
      jobId,
      month: month.label,
      naverWeb: naverWebResults.length,
      daum: daumResults.length,
      rss: rssResults.length,
      count: articles.length,
    }, "Bulk crawl: enriching publishers and deduplicating month");

    for (const candidate of articles) {
      if (!isRelevant(candidate.title, candidate.content) || !isValidUrl(candidate.url) || !Number.isFinite(candidate.publishedAt.getTime())) continue;
      const article = dependencies.db ? candidate : await enrichArticlePublisher(candidate);
      try {
        if (await refreshExcludedArticle(database, existing, article)) { totalRefreshed++; continue; }
      } catch (err) {
        insertFailures++;
        logger.error({ err }, "Failed to refresh excluded article");
        continue;
      }
      if (isDuplicate(article.url, article.title, article.publishedAt, existingSet, article.source, article.mediaName)) {
        totalDuplicates++;
        continue;
      }

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
        addToSet(article.url, article.title, article.publishedAt, existingSet, article.source, article.mediaName);
      } catch (err: unknown) {
        const error = err as { code?: string; cause?: { code?: string } };
        const code = error.code ?? error.cause?.code;
        if (code === "23505" || code === "P2002") totalDuplicates++;
        else { insertFailures++; logger.error({ err }, "Failed to insert article"); }
      }
    }

    const progressAfterMonth = Math.round(((i + 1) / totalMonths) * 90);
    await database.update(crawlJobsTable).set({
      collected: totalCollected,
      duplicates: totalDuplicates,
      progress: progressAfterMonth,
      total: totalCollected + totalDuplicates + totalRefreshed,
    }).where(eq(crawlJobsTable.id, jobId));

    if (!dependencies.db && i < months.length - 1) await sleepWithJitter(8000, 12000);
  }

  await database.update(crawlJobsTable).set({
    status: insertFailures > 0 || (candidates === 0 && (crawlWarnings.getStore()?.length ?? 0) > 0) ? "error" : "done",
    progress: 100,
    currentSource: "",
    total: totalCollected + totalDuplicates + totalRefreshed,
    collected: totalCollected,
    duplicates: totalDuplicates,
    error: [`후보 ${candidates}, 기존 기사 내용 갱신 ${totalRefreshed}, 저장 실패 ${insertFailures}`, ...(crawlWarnings.getStore() ?? [])].join("\n"),
  }).where(eq(crawlJobsTable.id, jobId));

  logger.info({ jobId, totalCollected, totalDuplicates, totalRefreshed, totalMonths }, "Paced bulk crawl job complete");
}

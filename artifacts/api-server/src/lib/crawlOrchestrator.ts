import { db } from "@workspace/db";
import { articlesTable, crawlJobsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { crawlWarnings, validateDateRange, warnSource } from "./crawlRuntime";
import { withCrawlLock } from "./crawlLock";
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
import { loadExistingArticles, refreshExcludedArticle } from "./existingArticles";

export interface CrawlJobDependencies {
  db?: typeof db;
  analyzeArticleSentiment?: typeof analyzeArticleSentiment;
  crawlAllSources?: typeof crawlAllSources;
  crawlNaverNews?: typeof crawlNaverNews;
  crawlDaumNews?: typeof crawlDaumNews;
  crawlNaverWebSearch?: typeof crawlNaverWebSearch;
}

export async function runCrawlJob(
  jobId: string,
  startDate: string,
  endDate: string,
  dependencies: CrawlJobDependencies = {},
): Promise<void> {
  validateDateRange(startDate, endDate);
  const run = () => crawlWarnings.run([], () => executeCrawlJob(jobId, startDate, endDate, dependencies));
  return dependencies.db ? run() : withCrawlLock(run, jobId);
}

async function executeCrawlJob(
  jobId: string,
  startDate: string,
  endDate: string,
  dependencies: CrawlJobDependencies = {},
): Promise<void> {
  const database = dependencies.db ?? db;
  const analyze = dependencies.analyzeArticleSentiment ?? analyzeArticleSentiment;
  const crawlSources = {
    all: dependencies.crawlAllSources ?? crawlAllSources,
    naver: dependencies.crawlNaverNews ?? crawlNaverNews,
    daum: dependencies.crawlDaumNews ?? crawlDaumNews,
    naverWeb: dependencies.crawlNaverWebSearch ?? crawlNaverWebSearch,
  };
  const existing = await loadExistingArticles(database);
  const { existingSet } = existing;
  let totalCollected = 0;
  let totalDuplicates = 0;
  let totalRefreshed = 0;
  let insertFailures = 0;
  let filtered = 0;

  await database
    .update(crawlJobsTable)
    .set({ currentSource: "네이버 API·웹 + 다음 웹 + RSS 수집 중…", progress: 5 })
    .where(eq(crawlJobsTable.id, jobId));

  logger.info({ jobId }, "Starting parallel crawl: Naver API + Daum API + RSS sources");

  const [naverApiRes, naverWebRes, daumRes, rssRes] = await Promise.allSettled([
    crawlSources.naver(startDate, endDate),
    crawlSources.naverWeb(startDate, endDate),
    crawlSources.daum(startDate, endDate),
    crawlSources.all(startDate, endDate),
  ]);

  const naverApiResults = naverApiRes.status === "fulfilled" ? naverApiRes.value : [];
  const naverWebResults = naverWebRes.status === "fulfilled" ? naverWebRes.value : [];
  const daumResults     = daumRes.status     === "fulfilled" ? daumRes.value     : [];
  const rssResults      = rssRes.status      === "fulfilled" ? rssRes.value      : [];

  if (naverApiRes.status === "rejected") logger.error({ err: naverApiRes.reason, jobId }, "Naver API crawl failed");
  if (naverWebRes.status === "rejected") logger.error({ err: naverWebRes.reason, jobId }, "Naver web crawl failed");
  if (daumRes.status     === "rejected") logger.error({ err: daumRes.reason,     jobId }, "Daum crawl failed");
  if (rssRes.status      === "rejected") logger.error({ err: rssRes.reason,      jobId }, "RSS crawl failed");

  const articles: ArticleData[] = [...naverApiResults, ...naverWebResults, ...daumResults, ...rssResults];
  for (const [name, result] of [["네이버 API", naverApiRes], ["네이버 웹", naverWebRes], ["다음", daumRes], ["RSS", rssRes]] as const) {
    if (result.status === "rejected") warnSource(name, "수집 요청 실패 (서버 로그 확인)");
  }
  const sourceCounts = `네이버API ${naverApiResults.length}, 네이버웹 ${naverWebResults.length}, 다음 ${daumResults.length}, RSS ${rssResults.length}`;

  await database
    .update(crawlJobsTable)
    .set({
      currentSource: "중복 제거 및 DB 저장 중…",
      progress: 60,
    })
    .where(eq(crawlJobsTable.id, jobId));

  logger.info(
    { jobId, naverApi: naverApiResults.length, naverWeb: naverWebResults.length, daum: daumResults.length, rss: rssResults.length, total: articles.length },
    "Crawl complete, deduplicating",
  );

  for (const article of articles) {
    if (!isRelevant(article.title, article.content) || !isValidUrl(article.url) || !Number.isFinite(article.publishedAt.getTime())) { filtered++; continue; }
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

    const isNegative = await analyze(
      article.title,
      article.content,
    );

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
      // Postgres duplicate-key code (23505) may be on the error itself or nested
      // under .cause (Drizzle wraps the original pg error in _DrizzleQueryError).
      const e = err as { code?: string; cause?: { code?: string }; message?: string };
      const code = e?.code ?? e?.cause?.code;
      const isDupe =
        code === "23505" ||
        code === "P2002" ||
        (e?.message?.includes("duplicate key") ?? false) ||
        (e?.message?.includes("articles_url_unique") ?? false);
      if (isDupe) {
        totalDuplicates++;
      } else {
        insertFailures++;
        logger.error({ err }, "Failed to insert article");
      }
    }

    if (totalCollected % 20 === 0) {
      const progress = Math.min(
        95,
        60 + Math.round((totalCollected / Math.max(articles.length, 1)) * 35),
      );
      await database
        .update(crawlJobsTable)
        .set({ collected: totalCollected, duplicates: totalDuplicates, progress })
        .where(eq(crawlJobsTable.id, jobId));
    }
  }

  await database
    .update(crawlJobsTable)
    .set({
      status: insertFailures > 0 || (articles.length === 0 && (crawlWarnings.getStore()?.length ?? 0) > 0) ? "error" : "done",
      progress: 100,
      currentSource: "",
      total: articles.length,
      collected: totalCollected,
      duplicates: totalDuplicates,
      error: [sourceCounts, `필터 제외 ${filtered}, 기존 기사 내용 갱신 ${totalRefreshed}, 저장 실패 ${insertFailures}`, ...(crawlWarnings.getStore() ?? [])].join("\n"),
    })
    .where(eq(crawlJobsTable.id, jobId));

  logger.info({ jobId, totalCollected, totalDuplicates, totalRefreshed }, "Crawl job complete");
}

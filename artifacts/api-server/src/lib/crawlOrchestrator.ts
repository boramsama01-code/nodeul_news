import { crawlAllSourcesPaced } from "./pacedSources";
import { crawlDateChunks, settleSequentially } from "./crawlPacing";
import { createRelevanceReview } from "./relevanceReview";
import {crawlOfficialArchives} from "./officialArchives";
import { loadExistingArticles } from "./existingArticles";
import { db } from "@workspace/db";
import { articlesTable, crawlJobsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { crawlWarnings, decideJobStatus, validateDateRange, warnSource } from "./crawlRuntime";
import { withCrawlLock } from "./crawlLock";
import { logger } from "./logger";
import {
  isValidUrl,
  ArticleData,
} from "./crawlerUtils";
import { analyzeArticleSentiment } from "./aiAnalysis";
import { crawlAllSources, crawlNaverNews, crawlDaumNews, crawlNaverWebSearch } from "./crawlerSources";
import { enrichArticles } from "./publisherResolver";
import { withGoogleRssPolicy } from "./googleRssPolicy";

export interface CrawlJobDependencies {
  reviewOnly?: boolean;
  alternative?: boolean;
  db?: typeof db;
  analyzeArticleSentiment?: typeof analyzeArticleSentiment;
  crawlAllSources?: typeof crawlAllSources;
  crawlNaverNews?: typeof crawlNaverNews;
  crawlDaumNews?: typeof crawlDaumNews;
  crawlNaverWebSearch?: typeof crawlNaverWebSearch;
  enrichArticles?: typeof enrichArticles;
  createRelevanceReview?: typeof createRelevanceReview;
}

export async function runCrawlJob(
  jobId: string,
  startDate: string,
  endDate: string,
  dependencies: CrawlJobDependencies = {},
): Promise<void> {
  validateDateRange(startDate, endDate);
  const run = () => withGoogleRssPolicy(() =>
    crawlWarnings.run([], () => executeCrawlJob(jobId, startDate, endDate, dependencies)));
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
  const crawlSources = dependencies.reviewOnly ? {all: async () => [], naver: async () => [], daum: async () => [], naverWeb: async () => []} : {
    all: dependencies.crawlAllSources ?? (dependencies.alternative ? crawlOfficialArchives : crawlAllSourcesPaced),
    naver: dependencies.crawlNaverNews ?? (dependencies.alternative ? async()=>[] : crawlNaverNews),
    daum: dependencies.crawlDaumNews ?? crawlDaumNews,
    naverWeb: dependencies.crawlNaverWebSearch ?? (dependencies.alternative ? async()=>[] : crawlNaverWebSearch),
  };
  const existingArticles = await loadExistingArticles(database);
  const review = await (dependencies.createRelevanceReview || createRelevanceReview)(dependencies.db ? {directory: false, maxRequests: 0} : {});
  let totalCollected = 0;
  let totalDuplicates = 0;
  let totalRefreshed = 0;
  let insertFailures = 0;
  let filtered = 0;

  await database
    .update(crawlJobsTable)
    .set({ currentSource: dependencies.alternative ? "언론사 자체검색 + 다음 검색으로 보완 중…" : "네이버 API·웹 + 다음 웹 + RSS 수집 중…", progress: 5 })
    .where(eq(crawlJobsTable.id, jobId));

  logger.info({ jobId }, "Starting paced crawl: Naver API + Daum API + RSS sources");

  const [naverApiRes, naverWebRes, daumRes, rssRes] = await settleSequentially([
    () => crawlSources.naver(startDate, endDate),
    () => dependencies.db || dependencies.reviewOnly ? crawlSources.naverWeb(startDate, endDate) : crawlDateChunks("네이버 웹", crawlSources.naverWeb, startDate, endDate),
    () => dependencies.db || dependencies.reviewOnly ? crawlSources.daum(startDate, endDate) : crawlDateChunks("다음", crawlSources.daum, startDate, endDate),
    () => crawlSources.all(startDate, endDate),
  ], dependencies.db || dependencies.reviewOnly ? 0 : 2000);

  const naverApiResults = naverApiRes.status === "fulfilled" ? naverApiRes.value : [];
  const naverWebResults = naverWebRes.status === "fulfilled" ? naverWebRes.value : [];
  const daumResults     = daumRes.status     === "fulfilled" ? daumRes.value     : [];
  const rssResults      = rssRes.status      === "fulfilled" ? rssRes.value      : [];

  if (naverApiRes.status === "rejected") logger.error({ err: naverApiRes.reason, jobId }, "Naver API crawl failed");
  if (naverWebRes.status === "rejected") logger.error({ err: naverWebRes.reason, jobId }, "Naver web crawl failed");
  if (daumRes.status     === "rejected") logger.error({ err: daumRes.reason,     jobId }, "Daum crawl failed");
  if (rssRes.status      === "rejected") logger.error({ err: rssRes.reason,      jobId }, "RSS crawl failed");

  const candidates: ArticleData[] = [...review.retryCandidates(startDate, endDate), ...naverApiResults, ...naverWebResults, ...daumResults, ...rssResults];
  await database.update(crawlJobsTable).set({ currentSource: "원문 링크와 언론사 확인 중…", progress: 50 }).where(eq(crawlJobsTable.id, jobId));
  const enrich = dependencies.enrichArticles ?? (dependencies.db ? async (items: ArticleData[]) => items : enrichArticles);
  const articles = await enrich(candidates, { maxRequests: 180 });
  for (const [name, result] of [["네이버 API", naverApiRes], ["네이버 웹", naverWebRes], ["다음", daumRes], ["RSS", rssRes]] as const) {
    if (result.status === "rejected") warnSource(name, "수집 요청 실패 (서버 로그 확인)");
  }
  const sourceCounts = dependencies.alternative ? `구글 제외 보완: 공식 검색 ${rssResults.length}, 다음 ${daumResults.length}` : `네이버API ${naverApiResults.length}, 네이버웹 ${naverWebResults.length}, 다음 ${daumResults.length}, RSS·자체검색 ${rssResults.length}`;

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

  for (const [articleIndex, candidate] of articles.entries()) {
    let article = candidate;
    if (!isValidUrl(article.url) || !Number.isFinite(article.publishedAt.getTime())) { filtered++; continue; }
    const reviewExisting = existingArticles.needsReview(article);
    if (reviewExisting) article = (await review.assess(article)).article;
    try { if (await existingArticles.refresh(article)) { totalRefreshed++; await review.delivered(article); continue; } }
    catch (err) { insertFailures++; logger.error({err}, "Failed to refresh existing article"); continue; }
    if (await existingArticles.duplicate(article, candidates[articleIndex]?.url)) {
      totalDuplicates++;
      if (!reviewExisting) await review.delivered(article);
      continue;
    }

    const assessed = await review.assess(article);
    if (assessed.decision.status !== "related") { filtered++; continue; }
    article = assessed.article;
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
      existingArticles.remember(article);
      await review.delivered(article);
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

  await review.flush().catch(() => {});
  const pending = review.pendingCount?.() ?? 0;
  if (pending > 0) warnSource("원문 확인", `관련성 확인 대기 ${pending}건: 저장되지 않음`);
  await database
    .update(crawlJobsTable)
    .set({
      status: decideJobStatus({ insertFailures, candidates: articles.length, warnings: crawlWarnings.getStore() ?? [], strict: dependencies.alternative }),
      progress: 100,
      currentSource: "",
      total: articles.length,
      collected: totalCollected,
      duplicates: totalDuplicates,
      error: [sourceCounts, `필터 제외 ${filtered}, 저장 실패 ${insertFailures}`, review.summary(), existingArticles.summary(), ...(crawlWarnings.getStore() ?? [])].join("\n"),
    })
    .where(eq(crawlJobsTable.id, jobId));

  logger.info({ jobId, totalCollected, totalDuplicates, totalRefreshed }, "Crawl job complete");
}

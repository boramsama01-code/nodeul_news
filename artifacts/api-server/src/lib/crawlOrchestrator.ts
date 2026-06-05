import { db } from "@workspace/db";
import { articlesTable, crawlJobsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "./logger";
import {
  isRelevant,
  isDuplicate,
  addToSet,
  isValidUrl,
  ArticleData,
} from "./crawlerUtils";
import { crawlAllSources, crawlNaverNews, crawlDaumNews, crawlNaverWebSearch } from "./crawlerSources";

async function loadExistingSet(): Promise<Set<string>> {
  const existingSet = new Set<string>();
  const existing = await db
    .select({
      url: articlesTable.url,
      title: articlesTable.title,
      publishedAt: articlesTable.publishedAt,
    })
    .from(articlesTable);

  for (const a of existing) {
    existingSet.add(a.url.toLowerCase().trim().replace(/\/$/, ""));
    const dateStr = a.publishedAt.toISOString().split("T")[0];
    existingSet.add(`${a.title.trim().replace(/\s+/g, "")}__${dateStr}`);
  }

  return existingSet;
}

export async function runCrawlJob(
  jobId: string,
  startDate: string,
  endDate: string,
): Promise<void> {
  const existingSet = await loadExistingSet();
  let totalCollected = 0;
  let totalDuplicates = 0;

  await db
    .update(crawlJobsTable)
    .set({ currentSource: "네이버API + 다음API + RSS 병렬 수집 중…", progress: 5 })
    .where(eq(crawlJobsTable.id, jobId));

  logger.info({ jobId }, "Starting parallel crawl: Naver API + Daum API + RSS sources");

  const [naverApiRes, naverWebRes, daumRes, rssRes] = await Promise.allSettled([
    crawlNaverNews(startDate, endDate),
    crawlNaverWebSearch(startDate, endDate),
    crawlDaumNews(startDate, endDate),
    crawlAllSources(startDate, endDate),
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

  await db
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
    if (!isRelevant(article.title, article.content)) continue;
    if (!isValidUrl(article.url)) continue;
    if (isDuplicate(article.url, article.title, article.publishedAt, existingSet)) {
      totalDuplicates++;
      continue;
    }

    addToSet(article.url, article.title, article.publishedAt, existingSet);

    const isNegative = false; // 자동 판단 비활성화 — 수동으로만 설정

    try {
      await db.insert(articlesTable).values({
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
        logger.error({ err }, "Failed to insert article");
      }
    }

    if (totalCollected % 20 === 0) {
      const progress = Math.min(
        95,
        60 + Math.round((totalCollected / Math.max(articles.length, 1)) * 35),
      );
      await db
        .update(crawlJobsTable)
        .set({ collected: totalCollected, duplicates: totalDuplicates, progress })
        .where(eq(crawlJobsTable.id, jobId));
    }
  }

  await db
    .update(crawlJobsTable)
    .set({
      status: "done",
      progress: 100,
      currentSource: "",
      total: totalCollected + totalDuplicates,
      collected: totalCollected,
      duplicates: totalDuplicates,
    })
    .where(eq(crawlJobsTable.id, jobId));

  logger.info({ jobId, totalCollected, totalDuplicates }, "Crawl job complete");
}

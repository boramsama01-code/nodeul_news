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
import { crawlAllSources, crawlNaverNews } from "./crawlerSources";

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
    .set({ currentSource: "네이버API + RSS 병렬 수집 중…", progress: 5 })
    .where(eq(crawlJobsTable.id, jobId));

  logger.info({ jobId }, "Starting parallel crawl: Naver API + RSS sources");

  // Run Naver API and RSS sources in parallel
  const [naverArticles, rssArticles] = await Promise.allSettled([
    crawlNaverNews(startDate, endDate),
    crawlAllSources(startDate, endDate),
  ]);

  const naverResults = naverArticles.status === "fulfilled" ? naverArticles.value : [];
  const rssResults = rssArticles.status === "fulfilled" ? rssArticles.value : [];

  if (naverArticles.status === "rejected") {
    logger.error({ err: naverArticles.reason, jobId }, "Naver crawl failed");
  }
  if (rssArticles.status === "rejected") {
    logger.error({ err: rssArticles.reason, jobId }, "RSS crawl failed");
  }

  const articles: ArticleData[] = [...naverResults, ...rssResults];

  await db
    .update(crawlJobsTable)
    .set({
      currentSource: "중복 제거 및 DB 저장 중…",
      progress: 60,
    })
    .where(eq(crawlJobsTable.id, jobId));

  logger.info(
    { jobId, naver: naverResults.length, rss: rssResults.length, total: articles.length },
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
      const code = (err as { code?: string })?.code;
      if (code === "23505" || code === "P2002") {
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

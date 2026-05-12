import { db } from "@workspace/db";
import { articlesTable, crawlJobsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "./logger";
import {
  isRelevant,
  isDuplicate,
  addToSet,
  isValidUrl,
  ruleBasedSentiment,
  ArticleData,
} from "./crawlerUtils";
import {
  crawlNaverAPI,
  crawlGoogleRSS,
  crawlDaumNews,
  crawlBigKinds,
  crawlRSSFeeds,
  crawlPublisherSearch,
  crawlNaverSearch,
} from "./crawlerSources";

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

type SourceRunner = (start: string, end: string) => Promise<ArticleData[]>;

const SOURCES: { name: string; fn: SourceRunner }[] = [
  { name: "네이버API", fn: crawlNaverAPI },
  { name: "구글RSS", fn: crawlGoogleRSS },
  { name: "다음뉴스", fn: crawlDaumNews },
  { name: "BigKinds", fn: crawlBigKinds },
  { name: "RSS피드들", fn: crawlRSSFeeds },
  { name: "언론사검색", fn: crawlPublisherSearch },
  { name: "네이버검색", fn: crawlNaverSearch },
];

export async function runCrawlJob(
  jobId: string,
  startDate: string,
  endDate: string,
): Promise<void> {
  const existingSet = await loadExistingSet();
  let totalCollected = 0;
  let totalDuplicates = 0;

  for (let i = 0; i < SOURCES.length; i++) {
    const source = SOURCES[i];
    const progress = Math.round((i / SOURCES.length) * 90);

    await db
      .update(crawlJobsTable)
      .set({ currentSource: source.name, progress })
      .where(eq(crawlJobsTable.id, jobId));

    logger.info({ source: source.name, jobId }, "Starting crawl source");

    try {
      const articles = await source.fn(startDate, endDate);

      for (const article of articles) {
        if (!isRelevant(article.title, article.content)) continue;
        if (!isValidUrl(article.url)) continue;
        if (isDuplicate(article.url, article.title, article.publishedAt, existingSet)) {
          totalDuplicates++;
          continue;
        }

        addToSet(article.url, article.title, article.publishedAt, existingSet);

        // Apply rule-based sentiment if not already set
        const isNegative = article.isNegative || ruleBasedSentiment(article.title, article.content);

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

        // Update progress every 10 new articles
        if (totalCollected % 10 === 0) {
          await db
            .update(crawlJobsTable)
            .set({ collected: totalCollected, duplicates: totalDuplicates })
            .where(eq(crawlJobsTable.id, jobId));
        }
      }

      // Final update for this source
      await db
        .update(crawlJobsTable)
        .set({ collected: totalCollected, duplicates: totalDuplicates })
        .where(eq(crawlJobsTable.id, jobId));

      logger.info(
        { source: source.name, newArticles: totalCollected, duplicates: totalDuplicates },
        "Source complete",
      );
    } catch (err) {
      logger.error({ err, source: source.name }, "Source failed");
    }
  }

  await db
    .update(crawlJobsTable)
    .set({
      status: "done",
      progress: 100,
      total: totalCollected + totalDuplicates,
      collected: totalCollected,
      duplicates: totalDuplicates,
    })
    .where(eq(crawlJobsTable.id, jobId));

  logger.info({ jobId, totalCollected, totalDuplicates }, "Crawl job complete");
}

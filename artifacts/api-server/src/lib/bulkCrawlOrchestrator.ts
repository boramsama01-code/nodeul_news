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
import { crawlAllSources, crawlNaverNews, crawlDaumNews } from "./crawlerSources";

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

export async function runBulkCrawlJob(
  jobId: string,
  startDate: string,
  endDate: string,
): Promise<void> {
  const months = getMonthRanges(startDate, endDate);
  const totalMonths = months.length;

  logger.info({ jobId, totalMonths, startDate, endDate }, "Starting bulk crawl");

  const existingSet = await loadExistingSet();
  let totalCollected = 0;
  let totalDuplicates = 0;

  for (let i = 0; i < months.length; i++) {
    const month = months[i]!;
    const monthProgress = Math.round((i / totalMonths) * 90);

    await db
      .update(crawlJobsTable)
      .set({
        currentSource: `[${i + 1}/${totalMonths}] ${month.label} 수집 중…`,
        progress: monthProgress,
        collected: totalCollected,
        duplicates: totalDuplicates,
      })
      .where(eq(crawlJobsTable.id, jobId));

    logger.info({ jobId, month: month.label, start: month.start, end: month.end }, "Bulk crawl: processing month");

    const [naverArticles, daumArticles, rssArticles] = await Promise.allSettled([
      crawlNaverNews(month.start, month.end),
      crawlDaumNews(month.start, month.end),
      crawlAllSources(month.start, month.end),
    ]);

    const naverResults = naverArticles.status === "fulfilled" ? naverArticles.value : [];
    const daumResults  = daumArticles.status  === "fulfilled" ? daumArticles.value  : [];
    const rssResults   = rssArticles.status   === "fulfilled" ? rssArticles.value   : [];

    if (naverArticles.status === "rejected") {
      logger.error({ err: naverArticles.reason, jobId, month: month.label }, "Naver crawl failed for month");
    }
    if (daumArticles.status === "rejected") {
      logger.error({ err: daumArticles.reason, jobId, month: month.label }, "Daum crawl failed for month");
    }
    if (rssArticles.status === "rejected") {
      logger.error({ err: rssArticles.reason, jobId, month: month.label }, "RSS crawl failed for month");
    }

    const articles: ArticleData[] = [...naverResults, ...daumResults, ...rssResults];

    logger.info({ jobId, month: month.label, count: articles.length }, "Bulk crawl: deduplicating month");

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
    }

    const progressAfterMonth = Math.round(((i + 1) / totalMonths) * 90);
    await db
      .update(crawlJobsTable)
      .set({
        collected: totalCollected,
        duplicates: totalDuplicates,
        progress: progressAfterMonth,
        total: totalCollected + totalDuplicates,
      })
      .where(eq(crawlJobsTable.id, jobId));
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

  logger.info({ jobId, totalCollected, totalDuplicates, totalMonths }, "Bulk crawl job complete");
}

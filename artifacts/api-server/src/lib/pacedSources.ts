import { NEWS_SOURCES, type NewsSource } from "./rssFeedList";
import { crawlSource } from "./crawlerSources";
import { crawlDateChunks, mapInPacedBatches, sleepWithJitter } from "./crawlPacing";
import { logger } from "./logger";
import { validateDateRange, warnSource } from "./crawlRuntime";
import type { ArticleData } from "./crawlerUtils";

function uniqueSources(sources: readonly NewsSource[]): NewsSource[] {
  const seen = new Set<string>();
  return sources.filter((source) => {
    const key = `${source.method}\u0000${source.url}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function isHistorical(endDate: string): boolean {
  const end = new Date(`${endDate}T23:59:59+09:00`).getTime();
  return Date.now() - end > 21 * 86400_000;
}

function deduplicate(articles: ArticleData[]): ArticleData[] {
  const seen = new Set<string>();
  return articles.filter((article) => {
    const key = JSON.stringify([article.source, article.url, article.mediaName]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function crawlSourceBatch(
  sources: readonly NewsSource[],
  startDate: string,
  endDate: string,
  concurrency = 2,
): Promise<ArticleData[]> {
  const groups = await mapInPacedBatches(
    sources,
    (source) => crawlSource(source, startDate, endDate),
    { batchSize: 4, concurrency, pauseMinMs: 1700, pauseMaxMs: 3200 },
  );
  return groups.flat();
}

export async function crawlAllSourcesPaced(startDate: string, endDate: string): Promise<ArticleData[]> {
  validateDateRange(startDate, endDate);
  const all = uniqueSources(NEWS_SOURCES);
  const globalGoogle = all.find((source) => source.method === "google_news_rss" && source.domain === "news.google.com");
  const direct = all.filter((source) => source.method === "rss_direct");
  const publisherGoogle = all.filter((source) => source.method === "google_news_rss" && source !== globalGoogle);
  const historical = isHistorical(endDate);
  const results: ArticleData[] = [];

  if (globalGoogle) {
    results.push(...await crawlDateChunks(
      "구글뉴스 통합검색",
      (start, end) => crawlSource(globalGoogle, start, end),
      startDate,
      endDate,
      { days: 7, pauseMinMs: 1900, pauseMaxMs: 3400 },
    ));
  }

  if (historical) {
    warnSource(
      "직접 RSS",
      `${startDate}~${endDate}는 과거 기간이므로 최신 RSS를 같은 기간마다 반복 호출하지 않고 별도 상태 점검만 수행합니다.`,
    );
  } else {
    results.push(...await crawlSourceBatch(direct, startDate, endDate, 2));
  }

  const includePublisherSearches = !historical || process.env.DEEP_ARCHIVE_GOOGLE_SOURCES === "true";
  if (includePublisherSearches && publisherGoogle.length > 0) {
    logger.info({ count: publisherGoogle.length, startDate, endDate }, "Publisher-scoped Google search sweep started");
    results.push(...await crawlSourceBatch(publisherGoogle, startDate, endDate, 1));
    await sleepWithJitter(2500, 4500);
  }

  const deduped = deduplicate(results);
  logger.info(
    { startDate, endDate, historical, candidates: results.length, deduped: deduped.length },
    "Paced RSS/Google collection complete",
  );
  return deduped;
}

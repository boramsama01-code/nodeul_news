import Parser from "rss-parser";
import { logger } from "./logger";
import { isRelevant, stripHtml, isValidUrl, ArticleData } from "./crawlerUtils";
import { NEWS_SOURCES, NewsSource } from "./rssFeedList";

const TIMEOUT_MS = 10000;

const rssParser = new Parser({
  timeout: TIMEOUT_MS,
  customFields: {
    item: [["source", "source"], ["dc:creator", "creator"]],
  },
});

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`Timeout after ${ms}ms`)), ms),
    ),
  ]);
}

async function crawlSource(
  source: NewsSource,
  startDate: string,
  endDate: string,
): Promise<ArticleData[]> {
  const start = new Date(startDate);
  const end = new Date(endDate);
  end.setHours(23, 59, 59, 999);

  const results: ArticleData[] = [];

  try {
    const feed = await withTimeout(rssParser.parseURL(source.url), TIMEOUT_MS);

    for (const item of feed.items || []) {
      try {
        const title = stripHtml(item.title || "");
        if (!title) continue;

        const content = stripHtml(
          item.contentSnippet || item.content || item.summary || "",
        );

        const url = item.link || "";
        if (!isValidUrl(url)) continue;

        // rss_direct: filter by keyword; google_news_rss: already filtered
        if (source.method === "rss_direct") {
          if (!isRelevant(title, content)) continue;
        }

        // Date filtering — only apply if startDate/endDate provided
        if (item.pubDate || item.isoDate) {
          const pubDate = new Date(item.pubDate || item.isoDate || "");
          if (!isNaN(pubDate.getTime())) {
            if (pubDate < start || pubDate > end) continue;
          }
        }

        const pubDate = item.pubDate || item.isoDate
          ? new Date(item.pubDate || item.isoDate || "")
          : new Date();

        results.push({
          title,
          content,
          url,
          publishedAt: pubDate,
          mediaName: source.name,
          isNegative: false,
          isSelfPR: false,
          source: source.method,
        });
      } catch {
        // skip bad items silently
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.debug(`[SKIP] ${source.name} (${source.method}): ${msg}`);
  }

  return results;
}

export async function crawlAllSources(
  startDate: string,
  endDate: string,
): Promise<ArticleData[]> {
  const settled = await Promise.allSettled(
    NEWS_SOURCES.map((source) => crawlSource(source, startDate, endDate)),
  );

  const all: ArticleData[] = [];
  for (const result of settled) {
    if (result.status === "fulfilled") {
      all.push(...result.value);
    }
  }

  return all;
}

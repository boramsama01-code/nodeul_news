import Parser from "rss-parser";
import axios from "axios";
import { logger } from "./logger";
import { isRelevant, stripHtml, isValidUrl, resolveMediaName, ArticleData } from "./crawlerUtils";
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

        // Date filtering — only apply if pubDate exists
        if (item.pubDate || item.isoDate) {
          const pubDate = new Date(item.pubDate || item.isoDate || "");
          if (!isNaN(pubDate.getTime())) {
            if (pubDate < start || pubDate > end) continue;
          }
        }

        const pubDate = item.pubDate || item.isoDate
          ? new Date(item.pubDate || item.isoDate || "")
          : new Date();

        const mediaName = resolveMediaName(url, source.name);

        results.push({
          title,
          content,
          url,
          publishedAt: pubDate,
          mediaName,
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

// ── 네이버 뉴스 검색 API ──────────────────────────────────────────────────
// 쿼리당 최대 1000건 (100건 × 10페이지), 여러 키워드로 수집
const NAVER_QUERIES = [
  "노들섬",
  "노들 예술섬",
  "노들섬 공연",
  "노들섬 축제",
  "노들섬 개발",
];

interface NaverNewsItem {
  title: string;
  description: string;
  link: string;
  originallink: string;
  pubDate: string;
}

interface NaverNewsResponse {
  items: NaverNewsItem[];
  total: number;
  start: number;
  display: number;
}

async function fetchNaverNewsPage(
  query: string,
  start: number,
  display: number,
  clientId: string,
  clientSecret: string,
): Promise<NaverNewsItem[]> {
  const response = await axios.get<NaverNewsResponse>(
    "https://openapi.naver.com/v1/search/news.json",
    {
      params: { query, display, start, sort: "date" },
      headers: {
        "X-Naver-Client-Id": clientId,
        "X-Naver-Client-Secret": clientSecret,
      },
      timeout: TIMEOUT_MS,
    },
  );
  return response.data.items || [];
}

export async function crawlNaverNews(
  startDate: string,
  endDate: string,
): Promise<ArticleData[]> {
  const clientId = process.env.NAVER_CLIENT_ID;
  const clientSecret = process.env.NAVER_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    logger.warn("NAVER_CLIENT_ID/SECRET not set — skipping Naver News crawl");
    return [];
  }

  const start = new Date(startDate);
  const end = new Date(endDate);
  end.setHours(23, 59, 59, 999);

  const results: ArticleData[] = [];

  for (const query of NAVER_QUERIES) {
    let pageStart = 1;
    const display = 100;
    let consecutiveOutOfRange = 0;

    while (pageStart <= 1000) {
      try {
        const items = await fetchNaverNewsPage(query, pageStart, display, clientId, clientSecret);
        if (items.length === 0) break;

        let inRangeCount = 0;
        for (const item of items) {
          const title = stripHtml(item.title);
          const content = stripHtml(item.description);
          const url = item.originallink || item.link;

          if (!title || !isValidUrl(url)) continue;
          if (!isRelevant(title, content)) continue;

          const pubDate = new Date(item.pubDate);
          if (isNaN(pubDate.getTime())) continue;

          if (pubDate < start || pubDate > end) continue;

          inRangeCount++;
          const mediaName = resolveMediaName(url);

          results.push({
            title,
            content,
            url,
            publishedAt: pubDate,
            mediaName,
            isNegative: false,
            isSelfPR: false,
            source: "naver_api",
          });
        }

        // If this entire page had nothing in range and articles are getting older, stop
        if (inRangeCount === 0) {
          consecutiveOutOfRange++;
          if (consecutiveOutOfRange >= 2) break;
        } else {
          consecutiveOutOfRange = 0;
        }

        if (items.length < display) break;
        pageStart += display;

        // Small delay to be polite
        await new Promise((r) => setTimeout(r, 200));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn({ query, pageStart }, `Naver API error: ${msg}`);
        break;
      }
    }

    logger.debug({ query, found: results.length }, "Naver query complete");
  }

  logger.info({ total: results.length }, "Naver News crawl complete");
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

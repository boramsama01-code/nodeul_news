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

// Interpret a "YYYY-MM-DD" date string as KST (UTC+9) day boundaries
function kstStart(dateStr: string): Date { return new Date(dateStr + "T00:00:00+09:00"); }
function kstEnd(dateStr: string): Date   { return new Date(dateStr + "T23:59:59.999+09:00"); }

async function crawlSource(
  source: NewsSource,
  startDate: string,
  endDate: string,
): Promise<ArticleData[]> {
  const start = kstStart(startDate);
  const end   = kstEnd(endDate);

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
// 단일 "노들" 쿼리로 최대한 넓게 수집 — isRelevant 필터에서 불필요 항목 제거
const NAVER_QUERIES = ["노들"];

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

// Split a date range into monthly chunks to bypass the 1,000-result-per-query cap
function splitIntoMonths(startDate: string, endDate: string): Array<{ start: string; end: string }> {
  const ranges: Array<{ start: string; end: string }> = [];
  const globalStart = kstStart(startDate);
  const globalEnd   = kstEnd(endDate);

  let cursor = new Date(globalStart.getFullYear(), globalStart.getMonth(), 1);
  while (cursor <= globalEnd) {
    const monthEnd = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0);
    ranges.push({
      start: (cursor < globalStart ? globalStart : cursor).toISOString().split("T")[0]!,
      end:   (monthEnd > globalEnd ? globalEnd : monthEnd).toISOString().split("T")[0]!,
    });
    cursor = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1);
  }
  return ranges;
}

// Fetch all pages for one query over one month-sized date range
async function crawlNaverQueryForMonth(
  query: string,
  startDate: string,
  endDate: string,
  clientId: string,
  clientSecret: string,
): Promise<ArticleData[]> {
  const start = kstStart(startDate);
  const end   = kstEnd(endDate);

  const results: ArticleData[] = [];
  const display = 100;

  for (let pageStart = 1; pageStart <= 1000; pageStart += display) {
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
        results.push({
          title,
          content,
          url,
          publishedAt: pubDate,
          mediaName: resolveMediaName(url),
          isNegative: false,
          isSelfPR: false,
          source: "naver_api",
        });
      }

      // Once ALL items on a page are older than our start date, stop paginating
      // (API returns newest-first so this is reliable)
      const oldestOnPage = items[items.length - 1];
      if (oldestOnPage) {
        const oldestDate = new Date(oldestOnPage.pubDate);
        if (!isNaN(oldestDate.getTime()) && oldestDate < start && inRangeCount === 0) break;
      }

      if (items.length < display) break;
      await new Promise((r) => setTimeout(r, 150));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn({ query, pageStart }, `Naver API error: ${msg}`);
      break;
    }
  }

  return results;
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

  // Split into monthly chunks so each chunk stays well under the 1,000-item API cap.
  // A single "노들섬" query for 5 months can exceed 1,000 results, causing the API
  // to silently drop the oldest articles. Monthly splitting prevents this.
  const months = splitIntoMonths(startDate, endDate);
  logger.info({ months: months.length, startDate, endDate }, "Naver crawl: monthly split");

  const allResults: ArticleData[] = [];

  for (const month of months) {
    for (const query of NAVER_QUERIES) {
      const items = await crawlNaverQueryForMonth(query, month.start, month.end, clientId, clientSecret);
      allResults.push(...items);
      logger.debug({ query, month: month.start, found: items.length }, "Naver month+query done");
    }
  }

  logger.info({ total: allResults.length }, "Naver News crawl complete");
  return allResults;
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

// ── Daum(Kakao) 뉴스 검색 API ────────────────────────────────────────────
// 한 번 요청당 최대 50건, page 파라미터로 페이지네이션
interface KakaoNewsDoc {
  title: string;
  contents: string;
  url: string;
  datetime: string; // ISO 8601
  publisher?: string;
}

interface KakaoNewsResponse {
  documents: KakaoNewsDoc[];
  meta: { total_count: number; pageable_count: number; is_end: boolean };
}

async function crawlDaumForMonth(
  query: string,
  startDate: string,
  endDate: string,
  apiKey: string,
): Promise<ArticleData[]> {
  const start = kstStart(startDate);
  const end   = kstEnd(endDate);
  const results: ArticleData[] = [];
  const size = 50;

  for (let page = 1; page <= 50; page++) {
    try {
      const resp = await axios.get<KakaoNewsResponse>(
        "https://dapi.kakao.com/v2/search/news",
        {
          headers: { Authorization: `KakaoAK ${apiKey}` },
          params: { query, sort: "recency", page, size },
          timeout: TIMEOUT_MS,
        },
      );

      const { documents, meta } = resp.data;
      if (!documents || documents.length === 0) break;

      let anyInRange = false;
      for (const doc of documents) {
        const pubDate = new Date(doc.datetime);
        if (isNaN(pubDate.getTime())) continue;
        if (pubDate > end) continue;   // 아직 미래 기사 — 스킵
        if (pubDate < start) {
          // 이미 범위 이전 — 이후 페이지는 더 오래됨, 조기 종료
          anyInRange = false;
          break;
        }
        anyInRange = true;

        const title   = stripHtml(doc.title);
        const content = stripHtml(doc.contents);
        const url     = doc.url;

        if (!title || !isValidUrl(url)) continue;
        if (!isRelevant(title, content)) continue;

        const publisher = doc.publisher ?? "";
        results.push({
          title,
          content,
          url,
          publishedAt: pubDate,
          mediaName: resolveMediaName(url, publisher),
          isNegative: false,
          isSelfPR: false,
          source: "daum_api",
        });
      }

      if (meta.is_end || !anyInRange) break;
      await new Promise((r) => setTimeout(r, 150));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn({ query, page }, `Daum API error: ${msg}`);
      break;
    }
  }

  return results;
}

export async function crawlDaumNews(
  startDate: string,
  endDate: string,
): Promise<ArticleData[]> {
  const apiKey = process.env.KAKAO_REST_API_KEY;
  if (!apiKey) {
    logger.warn("KAKAO_REST_API_KEY not set — skipping Daum News crawl");
    return [];
  }

  const months = splitIntoMonths(startDate, endDate);
  logger.info({ months: months.length, startDate, endDate }, "Daum crawl: monthly split");

  const allResults: ArticleData[] = [];
  for (const month of months) {
    const items = await crawlDaumForMonth("노들", month.start, month.end, apiKey);
    allResults.push(...items);
    logger.debug({ month: month.start, found: items.length }, "Daum month done");
  }

  logger.info({ total: allResults.length }, "Daum News crawl complete");
  return allResults;
}

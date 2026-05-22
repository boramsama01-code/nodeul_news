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
// "노들섬"·"노들 예술섬" 두 쿼리로 수집 — 광범위한 "노들" 단어는 무관 기사가
// 수천 건 포함되어 1000건 한도를 금방 채우므로 제외한다
const NAVER_QUERIES = ["노들섬", "노들 예술섬", "노들 예술"];

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

// Split a date range into monthly chunks to bypass the 1,000-result-per-query cap.
// Operates purely on YYYY-MM-DD strings to avoid UTC↔KST timezone confusion.
function splitIntoMonths(startDate: string, endDate: string): Array<{ start: string; end: string }> {
  const ranges: Array<{ start: string; end: string }> = [];
  const [sy, sm] = startDate.split("-").map(Number) as [number, number, number];
  const [ey, em] = endDate.split("-").map(Number)   as [number, number, number];

  let year = sy;
  let month = sm; // 1-indexed

  while (year < ey || (year === ey && month <= em)) {
    const lastDay = new Date(year, month, 0).getDate(); // last day of this month
    const pad = (n: number) => String(n).padStart(2, "0");
    const monthStart = `${year}-${pad(month)}-01`;
    const monthEnd   = `${year}-${pad(month)}-${pad(lastDay)}`;

    ranges.push({
      start: (year === sy && month === sm) ? startDate : monthStart,
      end:   (year === ey && month === em) ? endDate   : monthEnd,
    });

    month++;
    if (month > 12) { month = 1; year++; }
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
    const items = await crawlDaumForMonth("노들섬", month.start, month.end, apiKey);
    allResults.push(...items);
    logger.debug({ month: month.start, found: items.length }, "Daum month done");
  }

  logger.info({ total: allResults.length }, "Daum News crawl complete");
  return allResults;
}

// ── 네이버 뉴스 웹 검색 (날짜 필터 직접 지정) ─────────────────────────────
// openapi.naver.com 은 최대 1,000건 한도로 과거 기사를 놓치는 구조적 한계가 있다.
// search.naver.com 의 날짜 필터(pd=3, ds/de)를 직접 스크래핑해 임의 기간을 커버한다.
// 파싱 기반: data-url 속성(기사 URL) + 앞부분 <a href> 텍스트(제목) + YYYY.MM.DD. 날짜
const NAVER_WEB_QUERIES = ["노들섬", "노들 예술섬", "노들 예술"];
const NAVER_WEB_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Accept-Language": "ko-KR,ko;q=0.9,en;q=0.8",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  Referer: "https://www.naver.com/",
};

function extractNaverWebArticles(
  html: string,
): Array<{ url: string; title: string; summary: string; dateStr: string }> {
  const articles: Array<{ url: string; title: string; summary: string; dateStr: string }> = [];

  // Each article has a data-url attribute with the original article URL
  const dataUrlRegex = /data-url="(https?:\/\/[^"]+)"/g;
  let m: RegExpExecArray | null;

  while ((m = dataUrlRegex.exec(html)) !== null) {
    const rawUrl = m[1]!;
    const url = rawUrl.replace(/&amp;/g, "&");
    const dataUrlPos = m.index;

    // Date: last YYYY.MM.DD. pattern in the 2500 chars before data-url
    const lookback = html.slice(Math.max(0, dataUrlPos - 2500), dataUrlPos);
    const dateMatches = [...lookback.matchAll(/(\d{4})\.(\d{2})\.(\d{2})\./g)];
    if (!dateMatches.length) continue;
    const d = dateMatches[dateMatches.length - 1]!;
    const dateStr = `${d[1]}-${d[2]}-${d[3]}`;

    // Title + summary: first two <a href="URL"> text contents in whole HTML
    const titleMatches: string[] = [];
    let searchPos = 0;
    // Try both raw (with &amp;) and decoded URL forms
    const candidates = rawUrl === url ? [url] : [url, rawUrl];
    while (titleMatches.length < 2 && searchPos < html.length) {
      let aIdx = -1;
      let foundCandidate = "";
      for (const cand of candidates) {
        const pos = html.indexOf(`href="${cand}"`, searchPos);
        if (pos !== -1 && (aIdx === -1 || pos < aIdx)) {
          aIdx = pos;
          foundCandidate = cand;
        }
      }
      if (aIdx === -1) break;
      const closeAngle = html.indexOf(">", aIdx);
      const closeA     = html.indexOf("</a>", closeAngle + 1);
      if (closeAngle === -1 || closeA === -1) break;
      const text = html.slice(closeAngle + 1, closeA).replace(/<[^>]+>/g, "").trim();
      if (text.length >= 3) titleMatches.push(text);
      searchPos = closeA + 1;
    }

    const title   = titleMatches[0] ?? "";
    const summary = titleMatches[1] ?? "";
    if (!title) continue;

    articles.push({ url, title, summary, dateStr });
  }

  return articles;
}

export async function crawlNaverWebSearch(
  startDate: string,
  endDate: string,
): Promise<ArticleData[]> {
  const allResults: ArticleData[] = [];
  const ds = startDate.replace(/-/g, ".");
  const de = endDate.replace(/-/g, ".");

  for (const query of NAVER_WEB_QUERIES) {
    let emptyPages = 0;

    for (let start = 1; start <= 1000; start += 10) {
      try {
        const resp = await axios.get<string>("https://search.naver.com/search.naver", {
          params: { where: "news", query, sort: 1, pd: 3, ds, de, start },
          headers: NAVER_WEB_HEADERS,
          timeout: 12000,
        });

        const articles = extractNaverWebArticles(resp.data as string);

        if (articles.length === 0) {
          emptyPages++;
          if (emptyPages >= 2) break;
          continue;
        }
        emptyPages = 0;

        for (const article of articles) {
          if (!isRelevant(article.title, article.summary)) continue;
          const pubDate = new Date(`${article.dateStr}T12:00:00+09:00`);
          if (isNaN(pubDate.getTime())) continue;
          const kstStart_ = kstStart(startDate);
          const kstEnd_   = kstEnd(endDate);
          if (pubDate < kstStart_ || pubDate > kstEnd_) continue;

          allResults.push({
            title:       article.title,
            content:     article.summary,
            url:         article.url,
            publishedAt: pubDate,
            mediaName:   resolveMediaName(article.url),
            isNegative:  false,
            isSelfPR:    false,
            source:      "naver_web",
          });
        }

        await new Promise((r) => setTimeout(r, 300));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn({ query, start }, `Naver web search error: ${msg}`);
        break;
      }
    }

    logger.debug({ query, ds, de, running: allResults.length }, "Naver web: query done");
    await new Promise((r) => setTimeout(r, 500));
  }

  logger.info({ total: allResults.length }, "Naver web search crawl complete");
  return allResults;
}

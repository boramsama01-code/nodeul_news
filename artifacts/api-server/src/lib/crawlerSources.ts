import Parser from "rss-parser";
import axios, { AxiosResponse } from "axios";
import * as cheerio from "cheerio";
import { logger } from "./logger";
import { isRelevant, stripHtml, isValidUrl, resolveMediaName, resolveMediaNameStrict, ArticleData } from "./crawlerUtils";
import { NEWS_SOURCES, GOOGLE_NEWS_SOURCES, NewsSource } from "./rssFeedList";
import { googleFeedUrl, kstDate, mapConcurrent, parseRssPublishedAt, warnSource, validateDateRange } from "./crawlRuntime";
import { COLLECTION_KEYWORDS, GOOGLE_NEWS_QUERY } from "./newsRelevance";
import { fetchRssFeed } from "./rssFeedCache";

const TIMEOUT_MS = 30000;

const rssParser = new Parser({
  timeout: TIMEOUT_MS,
  customFields: {
    item: [["source", "source"], ["dc:creator", "creator"]],
  },
});

// 배포 환경의 간헐적 네트워크 실패(timeout 등)를 흡수하는 재시도 래퍼
async function withRetry<T>(fn: () => Promise<T>, retries = 2, delayMs = 1500): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const status = (err as { response?: { status?: number } })?.response?.status;
      if (status && status >= 400 && status < 500 && status !== 429) throw err;
      if (attempt < retries) await new Promise((r) => setTimeout(r, delayMs * (attempt + 1)));
    }
  }
  throw lastErr;
}

// Interpret a "YYYY-MM-DD" date string as KST (UTC+9) day boundaries
function kstStart(dateStr: string): Date { return new Date(dateStr + "T00:00:00+09:00"); }
function kstEnd(dateStr: string): Date   { return new Date(dateStr + "T23:59:59.999+09:00"); }

export async function crawlSource(
  source: NewsSource,
  startDate: string,
  endDate: string,
): Promise<ArticleData[]> {
  const start = kstStart(startDate);
  const end   = kstEnd(endDate);

  const results: ArticleData[] = [];

  try {
    const url = source.method === "google_news_rss" ? googleFeedUrl(source.url, startDate, endDate) : source.url;
    const feed = await fetchRssFeed(source.method, url, () => withRetry(() => rssParser.parseURL(url), 1));

    for (const item of feed.items || []) {
      try {
        const title = stripHtml(item.title || "");
        if (!title) continue;

        const content = stripHtml(
          item.contentSnippet || item.content || item.summary || "",
        );

        const url = item.link || "";
        if (!isValidUrl(url)) continue;

        // Search engines can return related terms: validate every channel's text.
        if (!isRelevant(title, content)) continue;

        const pubDate = parseRssPublishedAt(item);
        if (!pubDate) {
          warnSource(source.name, "발행일이 없거나 잘못된 RSS 항목 제외");
          continue;
        }
        if (pubDate < start || pubDate > end) continue;

        let finalTitle = title;
        let mediaName: string;
        if (source.method === "google_news_rss") {
          // 구글뉴스 제목: "기사제목 - 언론사" → 마지막 " - " 기준 분리
          const sep = title.lastIndexOf(" - ");
          if (sep > 0) {
            const press = title.slice(sep + 3).trim();
            finalTitle = title.slice(0, sep).trim();
            mediaName = `구글뉴스(${press || "기타"})`;
          } else {
            mediaName = "구글뉴스(기타)";
          }
        } else {
          // rss_direct: source.name이 곧 언론사명 (단독 표기)
          mediaName = source.name;
        }

        results.push({
          title: finalTitle,
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
    warnSource(source.name, msg);
    if (source.method === "rss_direct") {
      warnSource(source.name, "직접 RSS 실패: 구글뉴스의 해당 언론사 검색으로 보완합니다.");
      const fallback = new URL("https://news.google.com/rss/search?hl=ko&gl=KR&ceid=KR:ko");
      fallback.searchParams.set("q", `(${GOOGLE_NEWS_QUERY}) site:${source.domain}`);
      return crawlSource({ ...source, name: `${source.name} (구글 보완)`, method: "google_news_rss", url: fallback.toString() }, startDate, endDate);
    }
  }

  logger.info({ source: source.name, method: source.method, accepted: results.length }, "Source collection complete");
  return results;
}

// ── 네이버 뉴스 검색 API ──────────────────────────────────────────────────
// 쿼리당 최대 1000건 (100건 × 10페이지), 여러 키워드로 수집
const NAVER_QUERIES = COLLECTION_KEYWORDS;

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
  const response = await withRetry<AxiosResponse<NaverNewsResponse>>(() => axios.get<NaverNewsResponse>(
    "https://openapi.naver.com/v1/search/news.json",
    {
      params: { query, display, start, sort: "date" },
      headers: {
        "X-Naver-Client-Id": clientId,
        "X-Naver-Client-Secret": clientSecret,
      },
      timeout: TIMEOUT_MS,
    },
  ));
  return response.data.items || [];
}

// Split date-filtered web searches into monthly chunks. This cannot bypass the API cap.
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
          mediaName: "네이버뉴스",
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
      if (pageStart === 901 && new Date(items[items.length - 1].pubDate) > start) {
        warnSource("네이버 API", "검색어별 최신 1,000건 한도 도달: 과거 기간 전체 수집을 보장할 수 없습니다.");
      }
      await new Promise((r) => setTimeout(r, 150));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const status = (err as { response?: { status?: number } })?.response?.status;
      warnSource("네이버 API", `HTTP ${status ?? "network"}, page ${pageStart}: ${msg}`);
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
    warnSource("네이버 API", "NAVER_CLIENT_ID / NAVER_CLIENT_SECRET 미설정");
    return [];
  }

  validateDateRange(startDate, endDate);
  // The API has no date parameter. Fetch each query once, then filter locally.

  const allResults: ArticleData[] = [];

    for (const query of NAVER_QUERIES) {
      const items = await crawlNaverQueryForMonth(query, startDate, endDate, clientId, clientSecret);
      allResults.push(...items);
    }

  logger.info({ total: allResults.length }, "Naver News crawl complete");
  return allResults;
}

export async function crawlAllSources(
  startDate: string,
  endDate: string,
): Promise<ArticleData[]> {
  validateDateRange(startDate, endDate);
  const results = await mapConcurrent(NEWS_SOURCES, 4, source => crawlSource(source, startDate, endDate));
  return results.flat();
}

// Google News-only crawl used for repairing historical imports without
// re-running the other portal and direct RSS sources.
export async function crawlGoogleNews(
  startDate: string,
  endDate: string,
): Promise<ArticleData[]> {
  validateDateRange(startDate, endDate);
  const all = (await mapConcurrent(GOOGLE_NEWS_SOURCES, 4, source => crawlSource(source, startDate, endDate))).flat();

  logger.info({ startDate, endDate, total: all.length }, "Google News-only crawl complete");
  return all;
}

// ── Daum 뉴스 웹 스크래핑 ────────────────────────────────────────────────
// Kakao /v2/search/news API는 폐기됨 → search.daum.net 직접 스크래핑
// 구조: .item-title > strong.tit-g > a (href=v.daum.net URL, text=제목)
//       URL 패턴 /v/YYYYMMDDXXXXXXXX 에서 날짜 추출
const DAUM_QUERIES = COLLECTION_KEYWORDS;
const DAUM_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Accept-Language": "ko-KR,ko;q=0.9,en;q=0.8",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
};

async function crawlDaumWebForMonth(
  query: string,
  startDate: string,
  endDate: string,
): Promise<ArticleData[]> {
  const results: ArticleData[] = [];
  const seenUrls = new Set<string>(); // Only accepted articles suppress later candidates.
  const seenPages = new Set<string>();
  const start = kstStart(startDate);
  const end   = kstEnd(endDate);

  const sd = startDate.replace(/-/g, "") + "000000";
  const ed = endDate.replace(/-/g, "")   + "235959";

  for (let page = 1; page <= 20; page++) {
    try {
      const resp = await withRetry<AxiosResponse<string>>(() => axios.get<string>("https://search.daum.net/search", {
        params: { w: "news", q: query, sort: "recency", period: "u", sd, ed, page },
        headers: DAUM_HEADERS,
        timeout: 30000,
        responseType: "text",
      }));

      const $ = cheerio.load(resp.data as string);
      const items = $(".item-title");
      if (items.length === 0) {
        if (page === 1 && !/검색결과가 없습니다|검색 결과가 없습니다|검색된 결과가 없습니다/.test($.text())) {
          warnSource("다음", "기사 요소를 찾지 못했습니다. 차단 또는 페이지 구조 변경을 확인하세요.");
        }
        break;
      }

      // A later result can contain a better snippet for the same URL. Stop only
      // when the actual result page repeats, independently of accepted URLs.
      const pageSignature = JSON.stringify(items.toArray().map(el => [
        $(el).find("a").first().attr("href"), $(el).parent().parent().text(),
      ]));
      if (seenPages.has(pageSignature)) {
        warnSource("다음", "동일 페이지 반복으로 페이지 탐색 중단 (일부 기사 누락 가능)");
        break;
      }
      seenPages.add(pageSignature);
      let outOfRangeCount = 0;

      items.each((_, el) => {
        const a     = $(el).find("a").first();
        const url   = a.attr("href") ?? "";
        const title = a.text().trim();

        if (!url || !title || !isValidUrl(url)) return;

        if (seenUrls.has(url)) return;

        // Extract date from v.daum.net URL: /v/YYYYMMDDXXXXXXXXX
        const dateM = url.match(/\/v\/(\d{4})(\d{2})(\d{2})\d+/);
        const dateStr = dateM ? `${dateM[1]}-${dateM[2]}-${dateM[3]}` : parseNaverDateText($(el).closest("li").find(".item-contents .gem-subinfo, .item-contents .txt_info, .gem-subinfo").text());
        if (!dateStr) { warnSource("다음", "발행일을 추출할 수 없는 기사 제외"); return; }
        const pubDate = new Date(`${dateStr}T12:00:00+09:00`);
        // Date can normalize impossible dates (for example February 30). Such
        // items must not count as evidence that the entire page is too old.
        if (isNaN(pubDate.getTime()) || kstDate(pubDate) !== dateStr) return;

        if (pubDate > end) return;
        if (pubDate < start) { outOfRangeCount++; return; }

        // Get content snippet from sibling .item-contents
        const bundle  = $(el).parent().parent(); // item-bundle-mid
        const content = bundle.find(".item-contents .conts-desc").text().trim();

        // 원본 언론사명: 기사 항목(li) 내 a.item-writer .txt_info
        const pressName = $(el).closest("li").find("a.item-writer .txt_info").first().text().trim();

        const cleanTitle   = stripHtml(title);
        const cleanContent = stripHtml(content);
        if (!isRelevant(cleanTitle, cleanContent)) return;
        seenUrls.add(url);

        results.push({
          title:       cleanTitle,
          content:     cleanContent,
          url,
          publishedAt: pubDate,
          mediaName:   `다음뉴스(${pressName || "기타"})`,
          isNegative:  false,
          isSelfPR:    false,
          source:      "daum_web",
        });
      });

      // A pinned, misordered, or undated result must not hide later in-range
      // pages. Stop on dates only when every result is valid and too old.
      if (outOfRangeCount === items.length) break;
      if (page === 20 && items.length >= 10) {
        warnSource("다음", `${query} ${startDate}~${endDate}: 20페이지 탐색 한도 도달 (일부 기사 누락 가능)`);
      }

      await new Promise((r) => setTimeout(r, 300));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      warnSource("다음", `page ${page}: ${msg}`);
      break;
    }
  }

  return results;
}

export async function crawlDaumNews(
  startDate: string,
  endDate: string,
): Promise<ArticleData[]> {
  const months = splitIntoMonths(startDate, endDate);
  logger.info({ months: months.length, startDate, endDate }, "Daum web crawl: monthly split");

  const allResults: ArticleData[] = [];
  for (const month of months) {
    for (const query of DAUM_QUERIES) {
      const items = await crawlDaumWebForMonth(query, month.start, month.end);
      allResults.push(...items);
      logger.debug({ query, month: month.start, found: items.length }, "Daum web month+query done");
    }
  }

  logger.info({ total: allResults.length }, "Daum News crawl complete");
  return allResults;
}

// ── 네이버 뉴스 웹 검색 (날짜 필터 직접 지정) ─────────────────────────────
// openapi.naver.com 은 최대 1,000건 한도로 과거 기사를 놓치는 구조적 한계가 있다.
// search.naver.com 의 날짜 필터(pd=3, ds/de)를 직접 스크래핑해 임의 기간을 커버한다.
// 파싱 기반: data-url 속성(기사 URL) + 앞부분 <a href> 텍스트(제목) + YYYY.MM.DD. 날짜
const NAVER_WEB_QUERIES = COLLECTION_KEYWORDS;
const NAVER_WEB_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Accept-Language": "ko-KR,ko;q=0.9,en;q=0.8",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  Referer: "https://www.naver.com/",
};

// Parse Naver date text (relative or absolute) → YYYY-MM-DD
// Naver uses: "N분 전" / "N시간 전" (today), "N일 전" (1-6 days ago), "어제" (yesterday),
// or absolute "YYYY.MM.DD" for older articles.
export function parseNaverDateText(text: string, now = new Date()): string {
  // Absolute: "2026.05.25" or "2026.05.25."
  const absM = text.match(/(\d{4})\.(\d{2})\.(\d{2})/);
  if (absM) return `${absM[1]}-${absM[2]}-${absM[3]}`;
  // Relative times
  const hoursM = text.match(/(\d+)시간 전/);
  if (hoursM) return kstDate(new Date(now.getTime() - parseInt(hoursM[1]) * 3600_000));
  const daysM = text.match(/(\d+)일 전/);
  if (daysM) return kstDate(new Date(now.getTime() - parseInt(daysM[1]) * 86_400_000));
  const minutesM = text.match(/(\d+)분 전/);
  if (minutesM) return kstDate(new Date(now.getTime() - parseInt(minutesM[1]) * 60_000));
  if (/방금|오늘/.test(text)) return kstDate(now);
  if (text.includes("어제")) return kstDate(new Date(now.getTime() - 86_400_000));
  return "";
}

// Naver search HTML (2025+) uses sds-comps-* design system.
// Article title links: <a href="ORIG_URL" … data-heatmap-target=".tit"><span …>TITLE</span></a>
// Date: relative ("N시간 전") or absolute ("YYYY.MM.DD") in next 6000 chars after the title link.
function extractNaverWebArticles(
  html: string,
): Array<{ url: string; title: string; summary: string; dateStr: string }> {
  const $ = cheerio.load(html);
  const results: Array<{ url: string; title: string; summary: string; dateStr: string }> = [];
  let searchFrom = 0; // advance to avoid matching same URL twice

  $('a[data-heatmap-target=".tit"]').each((_, el) => {
    const a = $(el);
    const rawHref = a.attr("href") ?? "";
    const url = rawHref.replace(/&amp;/g, "&");
    const title = a.text().trim();
    if (!url || !title || !isValidUrl(url)) return;

    // Find position of this anchor in raw HTML (advance past previously processed ones)
    const anchorSnippet = rawHref.slice(0, 60); // enough to be unique
    let pos = html.indexOf(anchorSnippet, searchFrom);
    if (pos < 0) pos = html.indexOf(anchorSnippet); // fallback to start
    searchFrom = pos + 1;

    // Date: publisher metadata appears ~1000 chars BEFORE the .tit link in Naver's DOM
    // Look back 2000 chars and forward 500 chars to cover the publisher/date block
    const lookAhead = html.slice(Math.max(0, pos - 2000), pos + 500);
    const dateStr = parseNaverDateText(lookAhead);
    if (!dateStr) return;

    // Summary: the .body sibling anchor (same URL, different heatmap target)
    const summary = $(`a[data-heatmap-target=".body"]`)
      .filter((_, el2) => {
        const h = $(el2).attr("href") ?? "";
        return h === rawHref || h.replace(/&amp;/g, "&") === url;
      })
      .text()
      .trim();

    results.push({ url, title, summary, dateStr });
  });

  return results;
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
    const seenUrls = new Set<string>();
    const seenPages = new Set<string>();

    for (let start = 1; start <= 1000; start += 10) {
      try {
        const resp = await withRetry<AxiosResponse<string>>(() => axios.get<string>("https://search.naver.com/search.naver", {
          params: { where: "news", query, sort: 1, pd: 3, ds, de, start },
          headers: NAVER_WEB_HEADERS,
          timeout: 30000,
        }));

        const articles = extractNaverWebArticles(resp.data as string);

        if (articles.length === 0) {
          if (start === 1 && !/검색결과가 없습니다|검색 결과가 없습니다/.test(String(resp.data))) warnSource("네이버 웹", "기사 요소를 찾지 못했습니다. 차단 또는 구조 변경을 확인하세요.");
          emptyPages++;
          if (emptyPages >= 2) break;
          continue;
        }
        emptyPages = 0;
        const pageSignature = JSON.stringify(articles);
        if (seenPages.has(pageSignature)) { warnSource("네이버 웹", "동일 페이지 반복으로 탐색 중단"); break; }
        seenPages.add(pageSignature);

        for (const article of articles) {
          if (seenUrls.has(article.url)) continue;
          if (!isRelevant(article.title, article.summary)) continue;
          const pubDate = new Date(`${article.dateStr}T12:00:00+09:00`);
          if (isNaN(pubDate.getTime())) continue;
          const kstStart_ = kstStart(startDate);
          const kstEnd_   = kstEnd(endDate);
          if (pubDate < kstStart_ || pubDate > kstEnd_) continue;
          seenUrls.add(article.url);

          allResults.push({
            title:       article.title,
            content:     article.summary,
            url:         article.url,
            publishedAt: pubDate,
            mediaName:   `네이버(${resolveMediaNameStrict(article.url) || "기타"})`,
            isNegative:  false,
            isSelfPR:    false,
            source:      "naver_web",
          });
        }

        if (start === 991 && articles.length >= 10) {
          warnSource("네이버 웹", `${query} ${startDate}~${endDate}: 100페이지 탐색 한도 도달 (일부 기사 누락 가능)`);
        }

        await new Promise((r) => setTimeout(r, 800));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        warnSource("네이버 웹", `start ${start}: ${msg}`);
        break;
      }
    }

    logger.debug({ query, ds, de, running: allResults.length }, "Naver web: query done");
    await new Promise((r) => setTimeout(r, 500));
  }

  logger.info({ total: allResults.length }, "Naver web search crawl complete");
  return allResults;
}

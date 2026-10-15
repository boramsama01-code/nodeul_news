import { hasDiscoveryKeyword } from "./relevance";
import {crawlOfficialArchives} from "./officialArchives";
import { fetchGoogleFeedXml, classifyProviderResponse, recordProviderHealth, readProviderHealth, providerResponseEvidence } from "./providerHealth";
import Parser from "rss-parser";
import axios, { AxiosResponse } from "axios";
import * as cheerio from "cheerio";
import { logger } from "./logger";
import { stripHtml, isValidUrl, resolveMediaName, resolveMediaNameStrict, cleanPublisherName, ArticleData } from "./crawlerUtils";
import { NEWS_SOURCES, GOOGLE_NEWS_SOURCES, NewsSource } from "./rssFeedList";
import { googleFeedUrl, shiftDate, kstDate, mapConcurrent, warnSource, validateDateRange } from "./crawlRuntime";
import { loadOfficialFeed, coverageForRange } from "./sourceFeeds";

const TIMEOUT_MS = 30000;

const rssParser = new Parser({
  timeout: 12000,
  customFields: {
    item: [["source", "source"], ["dc:creator", "creator"]],
  },
});

// Shared fallback queries (e.g. nine sections of one paper) are fetched once.
const googleFeeds = new Map<string, { expires: number; value: Promise<Awaited<ReturnType<typeof rssParser.parseURL>>> }>();
function loadGoogleFeed(url: string) {
  const cached=googleFeeds.get(url);
  if(cached && cached.expires>Date.now())return cached.value;
  const value=fetchGoogleFeedXml(url).then(xml=>rssParser.parseString(xml));
  googleFeeds.set(url,{expires:Date.now()+30*60_000,value});
  // Errors are governed by the shared provider cooldown rather than a stale promise.
  value.catch(()=>{if(googleFeeds.get(url)?.value===value)googleFeeds.delete(url);});
  if(googleFeeds.size>500)googleFeeds.delete(googleFeeds.keys().next().value!);
  return value;
}

export function googlePublisher(item: { title?: string; source?: unknown }): { title: string; publisher: string } {
  const title = stripHtml(item.title || "");
  const source = item.source;
  const supplied = typeof source === "string" ? source : source && typeof source === "object"
    ? String((source as Record<string, unknown>)._ || (source as Record<string, unknown>).name || "") : "";
  const sep = title.lastIndexOf(" - ");
  const publisher = stripHtml(supplied || (sep > 0 ? title.slice(sep + 3) : ""));
  return { title: sep > 0 && title.slice(sep + 3).trim() === publisher ? title.slice(0, sep).trim() : title, publisher };
}

// 배포 환경의 간헐적 네트워크 실패(timeout 등)를 흡수하는 재시도 래퍼
async function withRetry<T>(fn: () => Promise<T>, retries = 2, delayMs = 1500): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const status = (err as { response?: { status?: number } })?.response?.status;
      if (status && status >= 400 && status < 500) throw err;
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
  validateDateRange(startDate, endDate);
  const start = kstStart(startDate);
  const end   = kstEnd(endDate);

  const results: ArticleData[] = [];

  try {
    const url = source.method === "google_news_rss" ? googleFeedUrl(source.url, startDate, endDate) : source.url;
    const official = source.method === "rss_direct" ? await loadOfficialFeed(source) : null;
    const feed = official ? official.feed : await loadGoogleFeed(url);
    if (official) {
      logger.info({source: source.name, status: official.status, reason: official.reason, items: feed.items.length, coverage: coverageForRange(official, startDate, endDate)}, "Official feed checked");
    }

    if(source.method==='google_news_rss' && (feed.items?.length||0)>=100 && startDate<endDate)warnSource(source.name,'검색 피드 100건 상한 가능성: 짧은 기간으로 재점검 필요');
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
          if (!hasDiscoveryKeyword(title, content)) continue;
        }

        // Date filtering — only apply if pubDate exists
        if (item.pubDate || item.isoDate) {
          const pubDate = new Date(item.pubDate || item.isoDate || "");
          if (!isNaN(pubDate.getTime())) {
            if (pubDate < start || pubDate > end) continue;
          }
        }

        const pubDate = new Date(item.pubDate || item.isoDate || "");
        if (!Number.isFinite(pubDate.getTime())) {
          warnSource(source.name, "발행일이 없거나 잘못된 RSS 항목 제외");
          continue;
        }

        let finalTitle = title;
        let mediaName: string;
        if (source.method === "google_news_rss") {
          // 구글뉴스 제목: "기사제목 - 언론사" → 마지막 " - " 기준 분리
          const parsed = googlePublisher(item);
          finalTitle = parsed.title;
          mediaName = `구글뉴스(${parsed.publisher || "기타"})`;
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
    // A working latest-only feed cannot answer an older date-range query.
    // Search supplementation retains google_news_rss provenance.
    if (official && (!feed.items.length || !official.oldestPublishedAt || start < new Date(official.oldestPublishedAt))) {
      warnSource(source.name, "직접 피드의 보관 범위 밖 또는 피드 미지원: 구글뉴스 검색으로 기간을 보완합니다. 원문에 기사가 없다는 뜻은 아닙니다.");
      const fallback = new URL("https://news.google.com/rss/search?hl=ko&gl=KR&ceid=KR:ko");
      fallback.searchParams.set("q", `노들 site:${source.domain}`);
      results.push(...await crawlSource({ ...source, name: `${source.name} (구글 보완)`, method: "google_news_rss", url: fallback.toString() }, startDate, endDate));
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    warnSource(source.name, msg);
    if (source.method === "rss_direct") {
      warnSource(source.name, "직접 RSS 실패: 구글뉴스의 해당 언론사 검색으로 보완합니다.");
      const fallback = new URL("https://news.google.com/rss/search?hl=ko&gl=KR&ceid=KR:ko");
      fallback.searchParams.set("q", `노들 site:${source.domain}`);
      return crawlSource({ ...source, name: `${source.name} (구글 보완)`, method: "google_news_rss", url: fallback.toString() }, startDate, endDate);
    }
  }

  logger.info({ source: source.name, method: source.method, accepted: results.length }, "Source collection complete");
  return results;
}

// ── 네이버 뉴스 검색 API ──────────────────────────────────────────────────
// 쿼리당 최대 1000건 (100건 × 10페이지), 여러 키워드로 수집
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

        const pubDate = new Date(item.pubDate);
        if (isNaN(pubDate.getTime())) continue;
        if (pubDate < start || pubDate > end) continue;

        inRangeCount++;
        results.push({
          title,
          content,
          url,
          publishedAt: pubDate,
          mediaName: `네이버(${resolveMediaNameStrict(url) || "기타"})`,
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
  return [...results.flat(), ...await crawlOfficialArchives(startDate,endDate)];
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
const DAUM_QUERIES = ["노들"];
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
  const state = (await readProviderHealth()).daum_web;
  if (state?.blockedUntil && Date.parse(state.blockedUntil) > Date.now()) {
    warnSource('다음', state.reason + ' — 앱 요청 휴식 중');
    return [];
  }
  const results: ArticleData[] = [];
  const seenUrls = new Set<string>(); // de-dup within this month's crawl
  const start = kstStart(startDate);
  const end   = kstEnd(endDate);

  const sd = startDate.replace(/-/g, "") + "000000";
  const ed = endDate.replace(/-/g, "")   + "235959";

  for (let page = 1; page <= 20; page++) {
    try {
      const resp = await withRetry<AxiosResponse<string>>(() => axios.get<string>("https://search.daum.net/search", {
        params: { w: "news", q: query, sort: "recency", period: "u", sd, ed, p: page },
        headers: DAUM_HEADERS,
        timeout: 30000,
        responseType: "text",
        validateStatus: () => true,
      }));

      const status = resp.status ?? 200;
      const classification = classifyProviderResponse(status, String(resp.data));
      if (status !== 200 || classification.kind === 'challenge' || classification.kind === 'automated') {
        await recordProviderHealth('daum_web', {status:'limited', reason:classification.reason, httpStatus:status, checkedAt:new Date().toISOString(), blockedUntil:new Date(Date.now()+6*3600_000).toISOString()});
        warnSource('다음', classification.reason + ' — 6시간 동안 요청을 쉽니다.');
        break;
      }
      const $ = cheerio.load(resp.data as string);
      const items = $(".item-title");
      if (page === 1 && (items.length || /검색결과가 없습니다|검색 결과가 없습니다|검색된 결과가 없습니다/.test($.text()))) await recordProviderHealth('daum_web', {status:'ok', reason:items.length?'검색 기사 요소 추출 확인':'해당 기간 검색 결과 없음', httpStatus:200, checkedAt:new Date().toISOString()});
      if (items.length === 0) {
        if (page === 1 && !/검색결과가 없습니다|검색 결과가 없습니다|검색된 결과가 없습니다/.test($.text())) {
          warnSource("다음", "기사 요소를 찾지 못했습니다. 차단 또는 페이지 구조 변경을 확인하세요.");
        }
        break;
      }

      let outOfRangeCount = 0;
      let newOnPage = 0; // count items we haven't seen before

      items.each((_, el) => {
        const a     = $(el).find("a").first();
        const url   = a.attr("href") ?? "";
        const title = a.text().trim();

        if (!url || !title || !isValidUrl(url)) return;

        // Detect pagination returning same results (Daum sometimes repeats page 1 for all pages)
        if (seenUrls.has(url)) return;
        newOnPage++;
        seenUrls.add(url);

        // Extract date from v.daum.net URL: /v/YYYYMMDDXXXXXXXXX
        const dateM = url.match(/\/v\/(\d{4})(\d{2})(\d{2})\d+/);
        const dateStr = dateM ? `${dateM[1]}-${dateM[2]}-${dateM[3]}` : parseNaverDateText($(el).closest("li").find(".item-contents .gem-subinfo, .item-contents .txt_info, .gem-subinfo").text());
        if (!dateStr) { warnSource("다음", "발행일을 추출할 수 없는 기사 제외"); return; }
        const pubDate = new Date(`${dateStr}T12:00:00+09:00`);
        if (isNaN(pubDate.getTime())) return;

        if (pubDate > end) return;
        if (pubDate < start) { outOfRangeCount++; return; }

        // Get content snippet from sibling .item-contents
        const bundle  = $(el).parent().parent(); // item-bundle-mid
        const content = bundle.find(".item-contents .conts-desc").text().trim();

        // 원본 언론사명: 기사 항목(li) 내 a.item-writer .txt_info
        const pressName = $(el).closest("li").find("a.item-writer .txt_info").first().text().trim();

        const cleanTitle   = stripHtml(title);
        const cleanContent = stripHtml(content);

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

      // Stop if this page returned no new URLs (pagination stalled — same results repeating)
      if (newOnPage === 0) {
        warnSource("다음", "동일 페이지 반복으로 페이지 탐색 중단 (일부 기사 누락 가능)");
        break;
      }
      // Stop if most items are before the start date
      if (outOfRangeCount === newOnPage) break;
      const totalPagesMatch = String(resp.data).match(/totalPage:\s*(\d+)/);
      // Daum also uses zero when the result set has no additional pages.
      // Distinguish that explicit boundary from missing pagination metadata.
      if (totalPagesMatch && page >= Number(totalPagesMatch[1])) break;
      if (page === 20) warnSource("다음", `${startDate}~${endDate}: 20페이지 상한 도달, 짧은 기간으로 재점검 필요`);

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
const NAVER_WEB_QUERIES = ["노들"];
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
export function extractNaverWebArticles(html: string, exactSearchDay?: string): Array<{url:string;title:string;summary:string;dateStr:string;publisher:string;coarseDate:boolean}> {
  const $ = cheerio.load(html);
  const results: Array<{url:string;title:string;summary:string;dateStr:string;publisher:string;coarseDate:boolean}> = [];
  const seen = new Set<string>();
  const clean = (text:string) => text.replace(/새 창 열림/g, "").trim();
  $('a[data-heatmap-target=".tit"]').each((_, el) => {
    const a=$(el), url=a.attr("href") || "", title=clean(a.text());
    if (!isValidUrl(url) || !title || seen.has(url)) return;
    seen.add(url);
    // Scope metadata to one news card, never the previous article's raw HTML.
    const card=a.parents().filter((_, node)=>$(node).find('a[data-heatmap-target=".tit"]').length===1 && $(node).find('.sds-comps-profile-info-subtext').length>0).first();
    const dateText=card.find('.sds-comps-profile-info-subtext').text();
    // Week/month labels have no exact day: retain the card and narrow the search.
    const dateStr=parseNaverDateText(dateText) || (exactSearchDay && /\d+\s*(주|개월)\s*전/.test(dateText) ? exactSearchDay : '');
    const summary=clean(card.find('a[data-heatmap-target=".body"]').text());
    const publisher=cleanPublisherName(clean(card.find('.sds-comps-profile-info-title-text').first().text()));
    results.push({url,title,summary,dateStr,publisher,coarseDate:!dateStr && /\d+\s*(주|개월)\s*전/.test(dateText)});
  });
  return results;
}

export function naverNextPage(payload: unknown): string | null {
  const valid=(value:unknown):string|null => {
    if(typeof value!=="string") return null;
    try {const u=new URL(value);return u.protocol==="https:" && u.hostname==="s.search.naver.com" && /^\/p\/newssearch\/\d+\/api\/tab\/more$/.test(u.pathname) ? u.toString() : null;} catch{return null;}
  };
  if (payload && typeof payload==="object") return valid((payload as {url?:unknown}).url);
  if(typeof payload!=="string") return null;
  for(const match of payload.matchAll(/"url"\s*:\s*("(?:\\.|[^"\\])*")/g)) {
    try {const url=valid(JSON.parse(match[1]));if(url)return url;}catch{}
  }
  return null;
}

export function naverPageHtml(payload:unknown):string {
  if(typeof payload==="string") return payload;
  const collection=(payload as {collection?:Array<{html?:string}>})?.collection;
  return Array.isArray(collection) ? collection.map(c=>c.html||"").join("\n") : "";
}

export async function crawlNaverWebSearch(
  startDate: string,
  endDate: string,
): Promise<ArticleData[]> {
  validateDateRange(startDate,endDate);
  const health=(await readProviderHealth()).naver_web;
  if(health?.blockedUntil && Date.parse(health.blockedUntil)>Date.now()){warnSource('네이버 웹',health.reason+' — 앱 요청 휴식 중');return [];}
  const months=splitIntoMonths(startDate,endDate);
  if(months.length>1){const result:ArticleData[]=[];for(const month of months)result.push(...await crawlNaverWebSearch(month.start,month.end));return result;}
  const allResults: ArticleData[] = [];
  const ds = startDate.replace(/-/g, ".");
  const de = endDate.replace(/-/g, ".");

  for (const query of NAVER_WEB_QUERIES) {
    let emptyPages = 0;
    const seenUrls = new Set<string>();
    const seenPages = new Set<string>();
    let nextUrl: string | null = null;

    for (let start = 1; start <= 1000; start += 10) {
      try {
        const resp = await withRetry<AxiosResponse<string>>(() => axios.get<string>(nextUrl || "https://search.naver.com/search.naver", {
          params: nextUrl ? undefined : { where: "news", query, sort: 1, pd: 3, ds, de },
          headers: NAVER_WEB_HEADERS,
          timeout: 30000,
        }));

        const html = naverPageHtml(resp.data);
        const pageState=classifyProviderResponse(resp.status||200,html);
        if(['challenge','automated'].includes(pageState.kind))throw Object.assign(new Error(pageState.reason),{response:{status:resp.status||200,data:html}});
        const articles = extractNaverWebArticles(html, startDate===endDate ? startDate : undefined);
        if(articles.some(a=>a.coarseDate) && startDate<endDate){
          // At most one month (31 days), sequential and paced. Never turn "3 weeks ago" into a guessed date.
          const daily:ArticleData[]=[];
          for(let day=startDate;day<=endDate;day=shiftDate(day,1)){
            await new Promise(resolve=>setTimeout(resolve,3000));
            daily.push(...await crawlNaverWebSearch(day,day));
            const health=(await readProviderHealth()).naver_web;
            if(health?.blockedUntil && Date.parse(health.blockedUntil)>Date.now()){warnSource("네이버 웹","접근 제한으로 남은 일별 확인 중단: 추후 재점검 필요");break;}
          }
          return [...new Map([...allResults,...daily].map(a=>[a.url,a])).values()];
        }
        if(articles.some(a=>!a.dateStr))warnSource('네이버 웹','단일 날짜 검색에서도 발행일 확인 불가: 해당 기사 제외');
        if(start===1)await recordProviderHealth('naver_web',{status:articles.length || /검색결과가 없습니다|검색 결과가 없습니다/.test(html)?'ok':'error',reason:articles.length?'기사 요소 추출 확인':/검색결과가 없습니다|검색 결과가 없습니다/.test(html)?'해당 기간 검색 결과 없음':'기사 요소 없음 — 검색 결과 또는 페이지 구조 확인 필요',httpStatus:200,checkedAt:new Date().toISOString()});
        const following = naverNextPage(resp.data);

        if (articles.length === 0) {
          if (start === 1 && !/검색결과가 없습니다|검색 결과가 없습니다/.test(String(resp.data))) warnSource("네이버 웹", "기사 요소를 찾지 못했습니다. 차단 또는 구조 변경을 확인하세요.");
          emptyPages++;
          if (!following || emptyPages >= 2 || seenPages.has(following)) break;
          seenPages.add(following); nextUrl=following;
          continue;
        }
        emptyPages = 0;
        const fresh = articles.filter(article => !seenUrls.has(article.url));
        if (fresh.length === 0) { warnSource("네이버 웹", "동일 페이지 반복으로 탐색 중단"); break; }

        for (const article of fresh) {
          seenUrls.add(article.url);
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
            mediaName:   `네이버(${resolveMediaNameStrict(article.url) || article.publisher || "기타"})`,
            isNegative:  false,
            isSelfPR:    false,
            source:      "naver_web",
          });
        }

        if (!following) break;
        if (seenPages.has(following)) { warnSource("네이버 웹", "다음 결과 주소 반복: 짧은 기간으로 재점검 필요"); break; }
        seenPages.add(following); nextUrl=following;
        if (start === 991) warnSource("네이버 웹", `${startDate}~${endDate}: 100페이지 상한 도달`);
        await new Promise((r) => setTimeout(r, 3000));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const response=(err as {response?:{status:number;data?:unknown}}).response;
        const classification=response ? classifyProviderResponse(response.status,String(response.data||'')) : {kind:'network',reason:'네트워크 연결 또는 응답 시간 초과'};
        const challenge=['challenge','automated'].includes(classification.kind);
        const limited=challenge||[403,429].includes(response?.status||0);
        await recordProviderHealth('naver_web',{status:limited?'limited':'error',reason:classification.reason,httpStatus:response?.status,responseEvidence:response?providerResponseEvidence(String(response.data||'')):undefined,checkedAt:new Date().toISOString(),...(limited?{blockedUntil:new Date(Date.now()+(challenge?6*3600_000:15*60_000)).toISOString()}:{})});
        warnSource("네이버 웹", `start ${start}: ${classification.reason} — ${msg}`);
        break;
      }
    }

    logger.debug({ query, ds, de, running: allResults.length }, "Naver web: query done");
    await new Promise((r) => setTimeout(r, 500));
  }

  logger.info({ total: allResults.length }, "Naver web search crawl complete");
  return allResults;
}

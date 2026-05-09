import axios from "axios";
import * as cheerio from "cheerio";
import Parser from "rss-parser";
import iconv from "iconv-lite";
import { logger } from "./logger";
import {
  isRelevant,
  resolveMediaName,
  stripHtml,
  sleep,
  randomDelay,
  BROWSER_HEADERS,
  withRetry,
  isValidUrl,
  ArticleData,
} from "./crawlerUtils";
import { RSS_FEEDS } from "./rssFeedList";

const rssParser = new Parser({ timeout: 10000 });

// ===== SOURCE 1: Naver News API =====
export async function crawlNaverAPI(
  startDate: string,
  endDate: string,
): Promise<ArticleData[]> {
  const results: ArticleData[] = [];
  const clientId = process.env["NAVER_CLIENT_ID"] || "";
  const clientSecret = process.env["NAVER_CLIENT_SECRET"] || "";

  if (!clientId || !clientSecret) {
    logger.warn("Naver API credentials not set");
    return results;
  }

  const start = new Date(startDate);
  const end = new Date(endDate);
  end.setHours(23, 59, 59, 999);

  const keywords = ["노들섬", "노들"];

  // Run two sort modes: "date" (stops early at boundary) + "sim" (full scan for deep history)
  const sortModes: Array<{ sort: string; earlyStop: boolean }> = [
    { sort: "date", earlyStop: true },
    { sort: "sim", earlyStop: false },
  ];

  for (const keyword of keywords) {
    for (const { sort, earlyStop } of sortModes) {
      // Naver API max start index is 1000, so max 10 pages × 100 items
      for (let page = 1; page <= 10; page++) {
        const startIdx = (page - 1) * 100 + 1;
        try {
          await randomDelay();
          const response = await withRetry(async () => {
            const res = await axios.get(
              "https://openapi.naver.com/v1/search/news.json",
              {
                params: {
                  query: keyword,
                  display: 100,
                  start: startIdx,
                  sort,
                },
                headers: {
                  "X-Naver-Client-Id": clientId,
                  "X-Naver-Client-Secret": clientSecret,
                },
                timeout: 10000,
              },
            );
            if (res.status === 429) {
              await sleep(2000);
              throw new Error("Rate limited");
            }
            return res;
          });

          const items: Record<string, string>[] = response.data.items || [];
          if (items.length === 0) break;

          let reachedBeforeRange = false;

          for (const item of items) {
            try {
              const pubDate = new Date(item["pubDate"] || "");
              if (isNaN(pubDate.getTime())) continue;

              if (pubDate > end) continue;

              if (pubDate < start) {
                reachedBeforeRange = true;
                continue;
              }

              const title = stripHtml(item["title"] || "");
              const content = stripHtml(item["description"] || "");

              let url: string = item["originallink"] || item["link"] || "";
              let source = "naver_api";

              if (!url || url.includes("naver.com")) {
                url = item["link"] || "";
                source = "naver_aggregator";
              }

              if (!isValidUrl(url)) continue;
              const mediaName = resolveMediaName(url);

              results.push({
                title,
                content,
                url,
                publishedAt: pubDate,
                mediaName,
                isNegative: false,
                isSelfPR: false,
                source,
              });
            } catch (err) {
              logger.warn({ err }, "[Naver API] item parse error");
            }
          }

          if (earlyStop && reachedBeforeRange) {
            logger.info(
              { keyword, sort, page },
              "[Naver API] reached date boundary, stopping",
            );
            break;
          }

          if (items.length < 100) break;
        } catch (err) {
          logger.error({ err, keyword, sort, page }, "[Naver API] page error");
          break;
        }
      }
    }
  }

  return results;
}

// ===== SOURCE 2: Google News RSS =====
// Tries to decode the real article URL from Google's redirect URL
// Falls back to using the Google News URL directly
function decodeGoogleNewsUrl(googleUrl: string): string {
  try {
    // Google News RSS article links are base64-encoded in the path
    // Format: https://news.google.com/rss/articles/CBMi...
    // Try to extract from URL or just return the google URL itself
    return googleUrl;
  } catch {
    return googleUrl;
  }
}

export async function crawlGoogleRSS(
  startDate: string,
  endDate: string,
): Promise<ArticleData[]> {
  const results: ArticleData[] = [];
  const start = new Date(startDate);
  const end = new Date(endDate);
  end.setHours(23, 59, 59, 999);
  const keywords = ["노들섬", "노들"];

  // Shift endDate forward by 1 day for the Google after/before operators
  const beforeDate = new Date(end.getTime() + 86400000).toISOString().split("T")[0];

  for (const keyword of keywords) {
    try {
      const encodedKw = encodeURIComponent(
        `${keyword} after:${startDate} before:${beforeDate}`,
      );
      const feedUrl = `https://news.google.com/rss/search?q=${encodedKw}&hl=ko&gl=KR&ceid=KR:ko`;
      const feed = await withRetry(() => rssParser.parseURL(feedUrl), 2);

      for (const item of feed.items || []) {
        try {
          const pubDate = item.pubDate ? new Date(item.pubDate) : null;
          if (!pubDate || isNaN(pubDate.getTime())) continue;
          if (pubDate < start || pubDate > end) continue;

          const googleUrl = item.link || "";
          if (!googleUrl) continue;

          const title = stripHtml(item.title || "");
          const content = stripHtml(item.contentSnippet || item.content || "");

          // Use source URL from RSS item if available, otherwise use google URL
          // We no longer discard articles just because the redirect can't be resolved
          let articleUrl = googleUrl;

          // Try to get source URL from the item's source field
          const sourceUrl = (item as Record<string, unknown>)["source"]?.toString() || "";
          if (sourceUrl && isValidUrl(sourceUrl) && !sourceUrl.includes("google.com")) {
            articleUrl = sourceUrl;
          }

          const mediaName = item.creator && !item.creator.toLowerCase().includes("google")
            ? item.creator
            : resolveMediaName(articleUrl, undefined);

          results.push({
            title,
            content,
            url: articleUrl,
            publishedAt: pubDate,
            mediaName,
            isNegative: false,
            isSelfPR: false,
            source: "google_rss",
          });
        } catch (err) {
          logger.warn({ err }, "[Google RSS] item error");
        }
      }
    } catch (err) {
      logger.error({ err, keyword }, "[Google RSS] feed error");
    }
  }

  return results;
}

// Parse Korean date formats: "2026.01.30", "2026-01-30", "2026년 1월 30일"
function parseDotDate(raw: string): Date | null {
  if (!raw) return null;
  // "2026.01.30" or "2026.1.30"
  const dot = raw.match(/(\d{4})\.(\d{1,2})\.(\d{1,2})/);
  if (dot) return new Date(`${dot[1]}-${dot[2].padStart(2, "0")}-${dot[3].padStart(2, "0")}`);
  // ISO already
  const iso = raw.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return new Date(`${iso[1]}-${iso[2]}-${iso[3]}`);
  return null;
}

// ===== SOURCE 3: Daum News =====
export async function crawlDaumNews(
  startDate: string,
  endDate: string,
): Promise<ArticleData[]> {
  const results: ArticleData[] = [];
  const start = new Date(startDate);
  const end = new Date(endDate);
  end.setHours(23, 59, 59, 999);

  const sdFormatted = startDate.replace(/-/g, "");
  const edFormatted = endDate.replace(/-/g, "");
  const keywords = ["노들섬", "노들"];

  for (const keyword of keywords) {
    const encodedKw = encodeURIComponent(keyword);

    for (let page = 1; page <= 30; page++) {
      try {
        await randomDelay();
        const url = `https://search.daum.net/search?w=news&q=${encodedKw}&sort=recency&DA=PGD&period=u&sd=${sdFormatted}000000&ed=${edFormatted}235959&p=${page}`;
        const res = await withRetry(
          () =>
            axios.get(url, {
              headers: BROWSER_HEADERS,
              timeout: 12000,
              responseType: "arraybuffer",
            }),
          2,
        );

        const contentType = String(res.headers["content-type"] || "");
        let html: string;
        if (contentType.includes("euc-kr") || contentType.includes("ks_c_5601")) {
          html = iconv.decode(Buffer.from(res.data), "euc-kr");
        } else {
          html = res.data.toString("utf-8");
        }

        const $ = cheerio.load(html);
        // Correct selector: .c-item-content is the actual article card container
        const items = $(".c-item-content");

        if (items.length === 0) break;

        let foundInRange = false;
        items.each((_, el) => {
          try {
            // Title: .tit-g a or .item-title a
            const titleEl = $(el).find(".tit-g a, .item-title a, a.tit_c").first();
            const title = stripHtml(titleEl.text().trim());
            if (!title) return;

            let articleUrl = titleEl.attr("href") || "";
            if (!articleUrl) return;
            if (articleUrl.startsWith("//")) articleUrl = "https:" + articleUrl;
            if (!isValidUrl(articleUrl)) return;

            // Date: .gem-subinfo .txt_info contains "2026.01.30"
            const dateRaw = $(el)
              .find(".txt_info, .gem-subinfo .txt_info, .item-date, time")
              .first()
              .text()
              .trim();
            const pubDate = parseDotDate(dateRaw) || new Date(dateRaw);
            if (isNaN(pubDate.getTime())) return;
            if (pubDate < start || pubDate > end) return;

            // Excerpt: .conts-desc — critical for isRelevant() when title lacks 노들섬
            const excerpt = stripHtml($(el).find(".conts-desc").text().trim());

            if (!isRelevant(title, excerpt)) return;

            const mediaName =
              stripHtml($(el).find(".item-source, .f_nb, .pub_name, .txt_source").first().text().trim()) ||
              resolveMediaName(articleUrl);

            foundInRange = true;
            results.push({
              title,
              content: excerpt,
              url: articleUrl,
              publishedAt: pubDate,
              mediaName,
              isNegative: false,
              isSelfPR: false,
              source: "daum_news",
            });
          } catch {}
        });

        if (!foundInRange && page > 3) break;
      } catch (err) {
        logger.error({ err, keyword, page }, "[Daum News] page error");
        break;
      }
    }
  }

  return results;
}

// ===== SOURCE 4: BigKinds =====
export async function crawlBigKinds(
  startDate: string,
  endDate: string,
): Promise<ArticleData[]> {
  const results: ArticleData[] = [];
  const keywords = ["노들섬", "노들"];

  for (const keyword of keywords) {
    let page = 1;
    let totalCount = Infinity;

    while ((page - 1) * 100 < totalCount) {
      try {
        await randomDelay();
        const res = await withRetry(
          () =>
            axios.post(
              "https://www.bigkinds.or.kr/api/news/search.do",
              {
                query: keyword,
                startDate,
                endDate,
                page,
                pageSize: 100,
                sortType: "date",
                providerCodes: [],
                categoryList: [],
              },
              {
                headers: {
                  "Content-Type": "application/json",
                  ...BROWSER_HEADERS,
                },
                timeout: 10000,
              },
            ),
          2,
        );

        if (res.status === 401 || res.status === 403) {
          logger.warn("[BigKinds] Auth required, skipping");
          break;
        }

        const data = res.data;
        if (data?.result?.TOTAL_CNT !== undefined) {
          totalCount = data.result.TOTAL_CNT;
        }

        const items = data?.result?.DOCUMENTS || data?.data?.items || [];
        if (items.length === 0) break;

        for (const item of items) {
          try {
            const title = stripHtml(item.TITLE || item.title || "");
            const content = stripHtml(item.CONTENT || item.content || "");
            const url = item.NEWS_URL || item.url || "";
            if (!title || !isValidUrl(url)) continue;

            const pubDateStr = item.DATE || item.publishedAt || "";
            const pubDate = new Date(pubDateStr);
            if (isNaN(pubDate.getTime())) continue;

            const mediaName = item.PROVIDER || item.mediaName || resolveMediaName(url);

            results.push({
              title,
              content,
              url,
              publishedAt: pubDate,
              mediaName,
              isNegative: false,
              isSelfPR: false,
              source: "bigkinds",
            });
          } catch {}
        }

        page++;
        if (items.length < 100) break;
      } catch (err) {
        const axErr = err as { response?: { status: number }; message?: string };
        if (
          axErr?.response?.status === 401 ||
          axErr?.response?.status === 403 ||
          (axErr?.message || "").toLowerCase().includes("login")
        ) {
          logger.warn("[BigKinds] Auth failure, skipping");
          break;
        }
        logger.error({ err, keyword, page }, "[BigKinds] page error");
        break;
      }
    }
  }

  return results;
}

// ===== SOURCE 5: RSS Feeds =====
export async function crawlRSSFeeds(
  startDate: string,
  endDate: string,
): Promise<ArticleData[]> {
  const results: ArticleData[] = [];
  const start = new Date(startDate);
  const end = new Date(endDate);
  end.setHours(23, 59, 59, 999);

  for (const feed of RSS_FEEDS) {
    try {
      const parsed = await Promise.race([
        rssParser.parseURL(feed.url),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("timeout")), 10000),
        ),
      ]);

      for (const item of parsed.items || []) {
        try {
          const pubDate = item.pubDate ? new Date(item.pubDate) : null;
          if (!pubDate || isNaN(pubDate.getTime())) continue;
          if (pubDate < start || pubDate > end) continue;

          const title = stripHtml(item.title || "");
          const content = stripHtml(
            item.contentSnippet || item.content || item.summary || "",
          );

          if (!isRelevant(title, content)) continue;

          const url = item.link || "";
          if (!isValidUrl(url)) continue;

          const mediaName = resolveMediaName(url, feed.name);

          results.push({
            title,
            content,
            url,
            publishedAt: pubDate,
            mediaName,
            isNegative: false,
            isSelfPR: false,
            source: "rss",
          });
        } catch {}
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`[RSS SKIP] ${feed.name}: ${msg}`);
    }
  }

  return results;
}

// ===== SOURCE 6: Individual Publisher Search =====
const SEARCH_SOURCES = [
  {
    name: "오마이뉴스",
    buildUrl: (kw: string) =>
      `https://www.ohmynews.com/NWS_Web/Search/SearchNews.aspx?search_term=${encodeURIComponent(kw)}&page=1`,
    titleSelector: ".tit_news a",
    dateSelector: ".info_news span",
  },
  {
    name: "프레시안",
    buildUrl: (kw: string) =>
      `https://www.pressian.com/pages/search?q=${encodeURIComponent(kw)}`,
    titleSelector: ".list_news li .tit a",
    dateSelector: ".list_news li .date",
  },
  {
    name: "미디어오늘",
    buildUrl: (kw: string) =>
      `https://www.mediatoday.co.kr/?s=${encodeURIComponent(kw)}`,
    titleSelector: ".item-box h4 a",
    dateSelector: ".item-box .date",
  },
];

export async function crawlPublisherSearch(
  startDate: string,
  endDate: string,
): Promise<ArticleData[]> {
  const results: ArticleData[] = [];
  const start = new Date(startDate);
  const end = new Date(endDate);
  end.setHours(23, 59, 59, 999);
  const keywords = ["노들섬", "노들"];

  for (const source of SEARCH_SOURCES) {
    for (const keyword of keywords) {
      try {
        await randomDelay();
        const url = source.buildUrl(keyword);
        const res = await withRetry(
          () =>
            axios.get(url, {
              headers: BROWSER_HEADERS,
              timeout: 10000,
              responseType: "arraybuffer",
            }),
          2,
        );

        const html = res.data.toString("utf-8");
        const $ = cheerio.load(html);
        const titleEls = $(source.titleSelector);

        if (!titleEls.length) continue;

        titleEls.each((_, el) => {
          try {
            const title = $(el).text().trim();
            if (!title) return;

            let href = $(el).attr("href") || "";
            if (!href) return;
            if (href.startsWith("/")) href = `https://${new URL(url).hostname}${href}`;
            if (!isValidUrl(href)) return;

            const dateEl = $(el)
              .closest("li, article, .item-box")
              .find(source.dateSelector)
              .first();
            const dateStr = dateEl.text().trim();
            const pubDate = new Date(dateStr);
            if (isNaN(pubDate.getTime())) return;
            if (pubDate < start || pubDate > end) return;

            results.push({
              title,
              content: "",
              url: href,
              publishedAt: pubDate,
              mediaName: source.name,
              isNegative: false,
              isSelfPR: false,
              source: "publisher_search",
            });
          } catch {}
        });
      } catch (err) {
        logger.error({ err, source: source.name, keyword }, "[Publisher Search] error");
      }
    }
  }

  return results;
}

// ===== Naver Mobile Article Extractor =====
// Naver mobile uses sds-comps design system.
// Each article title is: <a href="URL"><span class="...headline1...">TITLE</span></a>
// Date span (2026.01.30.) appears ~2000-3000 chars BEFORE the title in the HTML stream.
// Body excerpt in <span class="...body1..."> appears AFTER the title.
function extractNaverMobileArticles(html: string): Array<{
  url: string;
  title: string;
  dateStr: string;
  content: string;
}> {
  const items: Array<{ url: string; title: string; dateStr: string; content: string }> = [];
  const seenUrls = new Set<string>();

  // Find every headline1 anchor: these are the article title links
  const headlineRe =
    /<a\s[^>]*href="([^"]+)"[^>]*>\s*<span[^>]*sds-comps-text-type-headline1[^>]*>([^<]+)<\/span>\s*<\/a>/g;

  let m: RegExpExecArray | null;
  while ((m = headlineRe.exec(html)) !== null) {
    const url = m[1];
    const rawTitle = m[2];
    const titleIdx = m.index;

    // Decode HTML entities (e.g. &amp; &quot; &#39;)
    const title = rawTitle
      .replace(/&amp;/g, "&")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .trim();

    if (!title || title.length < 5 || title.length > 160) continue;
    if (seenUrls.has(url)) continue;

    // Filter obvious non-article links
    if (
      url.includes("keep.naver") ||
      url.includes("nid.naver") ||
      url.includes("search.naver") ||
      url.includes("policy.naver") ||
      url.includes("help.naver")
    )
      continue;

    seenUrls.add(url);

    // ── Date ──
    // The article date span appears BEFORE the title (~2000-3000 chars earlier).
    // Pattern: <span ...>2026.01.30.</span>  (trailing dot is Naver's style)
    const lookback = html.substring(Math.max(0, titleIdx - 3500), titleIdx);
    const spanDateRe = /<span[^>]*>(\d{4}\.\d{2}\.\d{2})\.<\/span>/g;
    let dm: RegExpExecArray | null;
    let lastDate = "";
    while ((dm = spanDateRe.exec(lookback)) !== null) {
      lastDate = dm[1];
    }

    // ── Excerpt (body1 span) ──
    // The body excerpt appears immediately AFTER the title anchor.
    // May contain <mark> tags around the keyword, so allow nested HTML.
    const after = titleIdx + m[0].length;
    const forward = html.substring(after, after + 2000);
    const bodyMatch = forward.match(
      /<span[^>]*sds-comps-text-type-body1[^>]*>([\s\S]{20,600}?)<\/span>/,
    );
    const content = bodyMatch
      ? bodyMatch[1].replace(/<[^>]*>/g, "").trim()
      : "";

    items.push({ url, title, dateStr: lastDate, content });
  }

  return items;
}

// ===== SOURCE 7: Naver Mobile Search =====
// Uses m.search.naver.com which returns static HTML (no JS required).
// Desktop search.naver.com is SDS/React and not scrapable.
export async function crawlNaverSearch(
  startDate: string,
  endDate: string,
): Promise<ArticleData[]> {
  const results: ArticleData[] = [];
  const start = new Date(startDate);
  const end = new Date(endDate);
  end.setHours(23, 59, 59, 999);

  // ds/de format: "2026.01.01"  nso from/to: "20260101"
  const ds = startDate.replace(/-/g, ".");
  const de = endDate.replace(/-/g, ".");
  const nsoFrom = startDate.replace(/-/g, "");
  const nsoTo = endDate.replace(/-/g, "");
  const nso = encodeURIComponent(`so:dd,p:from${nsoFrom}to${nsoTo}`);

  const MOBILE_HEADERS = {
    "User-Agent":
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148",
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "ko-KR,ko;q=0.9,en;q=0.8",
    "Accept-Encoding": "gzip, deflate, br",
  };

  const keywords = ["노들섬", "노들"];

  for (const keyword of keywords) {
    const encodedKw = encodeURIComponent(keyword);

    for (let startNum = 1; startNum <= 101; startNum += 10) {
      try {
        await randomDelay();
        const url = `https://m.search.naver.com/search.naver?where=m_news&query=${encodedKw}&sort=1&ds=${ds}&de=${de}&nso=${nso}&start=${startNum}`;

        const res = await withRetry(
          () =>
            axios.get(url, {
              headers: MOBILE_HEADERS,
              timeout: 15000,
              responseType: "arraybuffer",
              maxRedirects: 3,
            }),
          2,
        );

        const html = res.data.toString("utf-8");
        const pageArticles = extractNaverMobileArticles(html);

        if (pageArticles.length === 0) {
          logger.info(
            { keyword, startNum },
            "[Naver Mobile] no articles on page, stopping",
          );
          break;
        }

        let addedCount = 0;
        for (const art of pageArticles) {
          try {
            const pubDate = parseDotDate(art.dateStr);
            if (!pubDate || isNaN(pubDate.getTime())) continue;
            if (pubDate < start || pubDate > end) continue;

            if (!isRelevant(art.title, art.content)) continue;
            if (!isValidUrl(art.url)) continue;

            const mediaName = resolveMediaName(art.url);

            results.push({
              title: art.title,
              content: art.content,
              url: art.url,
              publishedAt: pubDate,
              mediaName,
              isNegative: false,
              isSelfPR: false,
              source: "naver_mobile",
            });
            addedCount++;
          } catch {}
        }

        logger.info(
          { keyword, startNum, found: pageArticles.length, added: addedCount },
          "[Naver Mobile] page processed",
        );
      } catch (err) {
        logger.warn({ err, keyword, startNum }, "[Naver Mobile] request error");
        break;
      }
    }
  }

  return results;
}

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

  for (const keyword of keywords) {
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
                sort: "date",
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

        const items = response.data.items || [];
        if (items.length === 0) break;

        for (const item of items) {
          try {
            const pubDate = new Date(item.pubDate);
            if (isNaN(pubDate.getTime())) continue;
            if (pubDate < start || pubDate > end) continue;

            const title = stripHtml(item.title || "");
            const content = stripHtml(item.description || "");

            let url: string = item.originallink || item.link || "";
            let source = "naver_api";

            if (!url || url.includes("naver.com")) {
              url = item.link || "";
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

        if (items.length < 100) break;
      } catch (err) {
        logger.error({ err, keyword, page }, "[Naver API] page error");
        break;
      }
    }
  }

  return results;
}

// ===== SOURCE 2: Google News RSS =====
async function resolveGoogleRedirect(googleUrl: string): Promise<string | null> {
  try {
    const res = await withRetry(
      async () =>
        axios.get(googleUrl, {
          maxRedirects: 10,
          timeout: 10000,
          headers: BROWSER_HEADERS,
          validateStatus: () => true,
        }),
      3,
    );
    const finalUrl = String(res.request?.res?.responseUrl || res.config?.url || googleUrl);
    if (!finalUrl || finalUrl.includes("google.com")) return null;
    return finalUrl;
  } catch {
    return null;
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

  for (const keyword of keywords) {
    try {
      const encodedKw = encodeURIComponent(keyword);
      const feedUrl = `https://news.google.com/rss/search?q=${encodedKw}&hl=ko&gl=KR&ceid=KR:ko`;
      const feed = await withRetry(() => rssParser.parseURL(feedUrl), 2);

      for (const item of feed.items || []) {
        try {
          const pubDate = item.pubDate ? new Date(item.pubDate) : null;
          if (!pubDate || isNaN(pubDate.getTime())) continue;
          if (pubDate < start || pubDate > end) continue;

          const googleUrl = item.link || "";
          if (!googleUrl) continue;

          await randomDelay();
          const finalUrl = await resolveGoogleRedirect(googleUrl);
          if (!finalUrl || !isValidUrl(finalUrl)) continue;
          if (finalUrl.includes("google.com")) continue;

          const title = stripHtml(item.title || "");
          const content = stripHtml(item.contentSnippet || item.content || "");
          const mediaName = resolveMediaName(finalUrl, item.creator || undefined);

          results.push({
            title,
            content,
            url: finalUrl,
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

    for (let page = 1; page <= 20; page++) {
      try {
        await randomDelay();
        const url = `https://search.daum.net/search?w=news&q=${encodedKw}&sort=recency&DA=PGD&period=u&sd=${sdFormatted}000000&ed=${edFormatted}235959&p=${page}`;
        const res = await withRetry(
          () =>
            axios.get(url, {
              headers: BROWSER_HEADERS,
              timeout: 10000,
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
        const items = $(".c-item-search, .news-item, li[data-docid]");

        if (items.length === 0) break;

        let foundAny = false;
        items.each((_, el) => {
          try {
            const titleEl = $(el).find(".item-title a, .tit-g a, a.tit_c").first();
            const title = stripHtml(titleEl.text().trim());
            if (!title) return;

            let articleUrl = titleEl.attr("href") || "";
            if (!articleUrl) return;
            if (articleUrl.startsWith("//")) articleUrl = "https:" + articleUrl;
            if (!isValidUrl(articleUrl)) return;

            const mediaName = stripHtml(
              $(el).find(".item-source, .f_nb, .pub_name").first().text().trim(),
            ) || resolveMediaName(articleUrl);

            const dateText = $(el).find(".item-date, .date, time").first();
            const dateStr =
              dateText.attr("datetime") || dateText.text().trim();
            const pubDate = new Date(dateStr);
            if (isNaN(pubDate.getTime())) return;
            if (pubDate < start || pubDate > end) return;

            foundAny = true;
            results.push({
              title,
              content: "",
              url: articleUrl,
              publishedAt: pubDate,
              mediaName,
              isNegative: false,
              isSelfPR: false,
              source: "daum_news",
            });
          } catch {}
        });

        if (!foundAny) break;
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

// ===== SOURCE 7: Naver Extended Search =====
export async function crawlNaverSearch(
  startDate: string,
  endDate: string,
): Promise<ArticleData[]> {
  const results: ArticleData[] = [];
  const start = new Date(startDate);
  const end = new Date(endDate);
  end.setHours(23, 59, 59, 999);

  const fmtDate = (d: string) => d.replace(/-/g, ".");
  const keywords = ["노들섬", "노들"];

  for (const keyword of keywords) {
    const encodedKw = encodeURIComponent(keyword);
    const ds = fmtDate(startDate);
    const de = fmtDate(endDate);

    for (let startNum = 1; startNum <= 100; startNum += 10) {
      try {
        await randomDelay();
        const url = `https://search.naver.com/search.naver?where=news&query=${encodedKw}&sort=1&ds=${ds}&de=${de}&nso=so:dd,p:from${ds.replace(/\./g, "")}to${de.replace(/\./g, "")}&start=${startNum}`;
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
        const items = $(".news_area");
        if (!items.length) break;

        items.each((_, el) => {
          try {
            const titleEl = $(el).find(".news_tit").first();
            const title = titleEl.text().trim();
            if (!title) return;

            const href = titleEl.attr("href") || "";
            if (!isValidUrl(href)) return;

            const dateStr = $(el)
              .find(".info_group span.info:last-child")
              .text()
              .trim();
            const pubDate = new Date(dateStr);
            if (isNaN(pubDate.getTime())) return;
            if (pubDate < start || pubDate > end) return;

            const mediaName =
              $(el).find(".info_group a.info:first-child, .press").first().text().trim() ||
              resolveMediaName(href);

            results.push({
              title,
              content: "",
              url: href,
              publishedAt: pubDate,
              mediaName,
              isNegative: false,
              isSelfPR: false,
              source: "naver_search",
            });
          } catch {}
        });

        if (items.length < 10) break;
      } catch (err) {
        logger.warn({ err, keyword }, "[Naver Search] blocked or error");
        break;
      }
    }
  }

  return results;
}

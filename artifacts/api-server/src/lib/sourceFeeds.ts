import axios from "axios";
import * as cheerio from "cheerio";
import iconv from "iconv-lite";
import { discoverFeedUrlsFromHtml, parseOfficialFeedText } from "./rssTransport";
import type { NewsSource } from "./rssFeedList";

export interface OfficialFeedItem {
  title?: string; link?: string; content?: string; contentSnippet?: string;
  summary?: string; pubDate?: string; isoDate?: string;
  source?: unknown;
}
export interface FeedAttempt {
  url: string; finalUrl?: string; status?: number;
  outcome: string; items?: number; detail?: string;
}
export interface OfficialFeedResult {
  feed: { items: OfficialFeedItem[] };
  status: "normal" | "partial" | "unsupported";
  reason: string;
  endpoint: string | null;
  kind: "rss" | "atom" | "news_sitemap" | null;
  attempts: FeedAttempt[];
  oldestPublishedAt?: string;
  newestPublishedAt?: string;
  cached: boolean;
  requestCount: number;
}
export interface FeedResponse { status: number; body: string; url: string; contentType?: string }
export interface FeedOptions {
  /** Inject a transport for deterministic fixtures; the default only requests allowed official hosts. */
  fetch?: (url: string, allowed: (url: string) => boolean) => Promise<FeedResponse>;
  refresh?: boolean;
  discovery?: boolean;
  maxRequests?: number;
}

const feedCache = new Map<string, { expires: number; value: OfficialFeedResult }>();
const pendingFeeds = new Map<string, Promise<OfficialFeedResult>>();
const responseCache = new Map<string, { expires: number; value: Promise<FeedResponse> }>();
const MAX_CACHE = 512;
const SUCCESS_TTL = 15 * 60_000;
const FAILURE_TTL = 5 * 60_000;

function trimCache<T>(cache: Map<string, T>): void {
  while (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value!);
}
function allowedFor(source: NewsSource): (raw: string) => boolean {
  const domains = [source.domain.toLowerCase(), new URL(source.url).hostname.replace(/^www\./, "").toLowerCase()];
  return raw => {
    try {
      const url = new URL(raw);
      return /^https?:$/.test(url.protocol) && !url.username && !url.password &&
        (!url.port || url.port === "80" || url.port === "443") &&
        domains.some(d => url.hostname === d || url.hostname.endsWith(`.${d}`));
    } catch { return false; }
  };
}

async function requestOfficial(url: string, allowed: (url: string) => boolean): Promise<FeedResponse> {
  let current = url;
  const deadline = Date.now() + 12_000;
  for (let hop = 0; hop <= 4; hop++) {
    if (!allowed(current)) throw new Error("official_domain_mismatch");
    const response = await axios.get<ArrayBuffer>(current, {
      timeout: Math.max(1, deadline - Date.now()), maxRedirects: 0,
      responseType: "arraybuffer", maxContentLength: 3 * 1024 * 1024,
      validateStatus: () => true,
      headers: { "User-Agent": "Mozilla/5.0 (compatible; NodeulNewsRSS/1.0)", Accept: "application/rss+xml,application/atom+xml,application/xml,text/xml,text/html;q=0.8,*/*;q=0.5" },
    });
    if (response.status >= 300 && response.status < 400 && response.headers.location) {
      if (Date.now() >= deadline) throw new Error("redirect_timeout");
      current = new URL(response.headers.location, current).href;
      continue;
    }
    const data = Buffer.from(response.data);
    const contentType = String(response.headers["content-type"] || "");
    const head = data.subarray(0, 1500).toString("ascii");
    const charset = contentType.match(/charset\s*=\s*["']?([\w-]+)/i)?.[1]
      || head.match(/encoding\s*=\s*["']([^"']+)/i)?.[1]
      || head.match(/charset\s*=\s*["']?([\w-]+)/i)?.[1] || "utf-8";
    const body = iconv.decode(data, iconv.encodingExists(charset) ? charset : "utf-8");
    return { status: response.status, body, url: current, contentType };
  }
  throw new Error("redirect_limit");
}

async function cachedRequest(url: string, allowed: (url: string) => boolean): Promise<FeedResponse> {
  const prior = responseCache.get(url);
  if (prior && prior.expires > Date.now()) return prior.value;
  const value = requestOfficial(url, allowed);
  const record = { expires: Date.now() + SUCCESS_TTL, value };
  responseCache.set(url, record); trimCache(responseCache);
  value.then(r => { if (r.status >= 400) record.expires = Date.now() + FAILURE_TTL; }, () => { record.expires = Date.now() + FAILURE_TTL; });
  return value;
}

export async function parseOfficialDocument(body: string, url: string): Promise<{
  kind: OfficialFeedResult["kind"]; items: OfficialFeedItem[]; sitemaps: string[]; outcome: string;
}> {
  if (/<!DOCTYPE|<!ENTITY/i.test(body) && !/<html[\s>]/i.test(body)) {
    return { kind: null, items: [], sitemaps: [], outcome: "unsafe_xml_declaration" };
  }
  const $ = cheerio.load(body, { xmlMode: true });
  const root = $.root().children().first()[0]?.tagName?.toLowerCase();
  if (root === "rss" || root === "feed" || root === "rdf:rdf") {
    try {
      const parsed = await parseOfficialFeedText(body);
      const items = (parsed.feed.items || []) as OfficialFeedItem[];
      return { kind: root === "feed" ? "atom" : "rss", items, sitemaps: [], outcome: items.length ? parsed.parseMode === "rss-parser" ? "feed_ok" : `feed_repaired_${parsed.parseMode}` : "empty_feed" };
    } catch (err) {
      return { kind: null, items: [], sitemaps: [], outcome: `invalid_xml: ${err instanceof Error ? err.message.slice(0, 150) : String(err)}` };
    }
  }
  if (root === "sitemapindex") {
    return { kind: null, items: [], sitemaps: $("sitemap > loc").map((_, el) => $(el).text().trim()).get(), outcome: "sitemap_index" };
  }
  if (root === "urlset") {
    const items: OfficialFeedItem[] = [];
    $("url").each((_, el) => {
      const entry = $(el);
      const title = entry.find("news\\:title").text().trim();
      const pubDate = entry.find("news\\:publication_date").text().trim();
      const link = entry.children("loc").text().trim();
      // lastmod is a modification time, not a publication date. Never fabricate it.
      if (title && pubDate && link) items.push({ title, link, pubDate });
    });
    return { kind: "news_sitemap", items, sitemaps: [], outcome: items.length ? "news_sitemap_ok" : "sitemap_without_news_metadata" };
  }
  return { kind: null, items: [], sitemaps: [], outcome: /<html[\s>]|<!doctype html/i.test(body) ? "html_instead_of_feed" : "unrecognized_document" };
}

export function discoverOfficialLinks(body: string, base: string): { feeds: string[]; sitemaps: string[] } {
  const $ = cheerio.load(body);
  const feeds = new Set<string>(discoverFeedUrlsFromHtml(body, base));
  const sitemaps = new Set<string>();
  const add = (set: Set<string>, raw?: string) => {
    if (!raw) return;
    try { set.add(new URL(raw, base).href); } catch { /* invalid advertised URL */ }
  };
  $("link[rel~='alternate']").each((_, el) => {
    if (/rss|atom/i.test($(el).attr("type") || "")) add(feeds, $(el).attr("href"));
  });
  $("a[href]").each((_, el) => {
    const href = $(el).attr("href") || "";
    if (/rss|atom/i.test(href) && /\.xml(?:[?#]|$)|\/rss\/?(?:[?#]|$)|\/feed\//i.test(href)) add(feeds, href);
  });
  for (const match of body.matchAll(/^\s*Sitemap:\s*(\S+)/gim)) add(sitemaps, match[1]);
  return { feeds: [...feeds], sitemaps: [...sitemaps] };
}

async function loadUncached(source: NewsSource, options: FeedOptions): Promise<OfficialFeedResult> {
  const allowed = allowedFor(source);
  const transport = options.fetch || cachedRequest;
  const maxRequests = Math.min(10, Math.max(1, options.maxRequests ?? 8));
  const visited = new Set<string>();
  const attempts: FeedAttempt[] = [];
  let endpoint: string | null = null;
  let kind: OfficialFeedResult["kind"] = null;
  let items: OfficialFeedItem[] = [];
  const fallbackFeeds: string[] = [];
  const sitemaps: string[] = [];
  async function inspect(raw: string, parse: boolean): Promise<void> {
    if (visited.size >= maxRequests || visited.has(raw) || !allowed(raw)) return;
    visited.add(raw);
    try {
      const response = await transport(raw, allowed);
      if (!allowed(response.url)) throw new Error("official_domain_mismatch");
      if (response.status < 200 || response.status >= 300) {
        attempts.push({ url: raw, finalUrl: response.url, status: response.status, outcome: "http_error" }); return;
      }
      const links = discoverOfficialLinks(response.body, response.url);
      fallbackFeeds.push(...links.feeds); sitemaps.push(...links.sitemaps);
      if (!parse) { attempts.push({ url: raw, finalUrl: response.url, status: response.status, outcome: "discovery", detail: `${links.feeds.length} feed links; ${links.sitemaps.length} sitemaps` }); return; }
      const parsed = await parseOfficialDocument(response.body, response.url);
      attempts.push({ url: raw, finalUrl: response.url, status: response.status, outcome: parsed.outcome, items: parsed.items.length });
      sitemaps.push(...parsed.sitemaps);
      if (parsed.items.length) { items = parsed.items; kind = parsed.kind; endpoint = response.url; }
      else if (!kind && parsed.kind) { kind = parsed.kind; endpoint = response.url; }
    } catch (error) {
      attempts.push({ url: raw, outcome: "network_error", detail: error instanceof Error ? error.message.slice(0, 180) : String(error) });
    }
  }
  await inspect(source.url, true);
  if (!items.length && options.discovery !== false) {
    const host = new URL(source.url).hostname;
    const homepage = host === source.domain || host === `www.${source.domain}` ? new URL("/", source.url).href : `https://${source.domain}/`;
    await inspect(homepage, false);
    for (let i = 0; i < fallbackFeeds.length && i < 3 && !items.length; i++) await inspect(fallbackFeeds[i]!, true);
    if (!items.length) {
      await inspect(new URL("/robots.txt", homepage).href, false);
      // Follow only advertised maps, preferring news maps. Cap both breadth and depth.
      sitemaps.sort((a, b) => Number(/news/i.test(b)) - Number(/news/i.test(a)));
      for (let i = 0; i < sitemaps.length && i < 4 && !items.length; i++) await inspect(sitemaps[i]!, true);
    }
  }
  const seen = new Set<string>();
  items = items.filter(item => {
    if (!item.link || !allowed(item.link) || seen.has(item.link)) return false;
    seen.add(item.link); return true;
  });
  const dates = items.map(i => new Date(i.pubDate || i.isoDate || "").getTime()).filter(Number.isFinite).sort((a, b) => a - b);
  const recovered = attempts[0]?.outcome !== "feed_ok";
  const status = items.length ? (recovered || dates.length < items.length || kind === "news_sitemap" ? "partial" : "normal") : "unsupported";
  const reason = items.length
    ? kind === "news_sitemap" ? "advertised_news_sitemap" : recovered ? "recovered_official_feed" : dates.length < items.length ? "missing_publication_dates" : "official_feed_available"
    : attempts.some(a => a.outcome === "sitemap_without_news_metadata") ? "sitemap_found_without_titles_and_publication_dates" : "no_usable_official_feed";
  return { feed: { items }, status, reason, endpoint, kind, attempts, cached: false, requestCount: visited.size,
    oldestPublishedAt: dates.length ? new Date(dates[0]!).toISOString() : undefined,
    newestPublishedAt: dates.length ? new Date(dates[dates.length - 1]!).toISOString() : undefined };
}

export async function loadOfficialFeed(source: NewsSource, options: FeedOptions = {}): Promise<OfficialFeedResult> {
  if (options.fetch || options.refresh) return loadUncached(source, options);
  const key = `${source.domain}|${source.url}|${options.discovery !== false}|${options.maxRequests ?? 8}`;
  const cached = feedCache.get(key);
  if (cached && cached.expires > Date.now()) return { ...cached.value, cached: true };
  const pending = pendingFeeds.get(key);
  if (pending) return { ...await pending, cached: true };
  const promise = loadUncached(source, options);
  pendingFeeds.set(key, promise);
  try {
    const value = await promise;
    feedCache.set(key, { value, expires: Date.now() + (value.feed.items.length ? SUCCESS_TTL : FAILURE_TTL) }); trimCache(feedCache);
    return value;
  } finally { pendingFeeds.delete(key); }
}

export function coverageForRange(result: OfficialFeedResult, startDate: string, endDate: string): "overlap" | "outside_range" | "unknown" {
  if (!result.oldestPublishedAt || !result.newestPublishedAt) return "unknown";
  const start = new Date(`${startDate}T00:00:00+09:00`).getTime();
  const end = new Date(`${endDate}T23:59:59.999+09:00`).getTime();
  return new Date(result.oldestPublishedAt).getTime() > end || new Date(result.newestPublishedAt).getTime() < start ? "outside_range" : "overlap";
}

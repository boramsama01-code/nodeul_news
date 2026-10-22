import axios, { type AxiosResponse } from "axios";
import * as cheerio from "cheerio";
import * as iconv from "iconv-lite";
import { isIP } from "node:net";
import Parser from "rss-parser";

export interface RobustFeedItem {
  title?: string;
  contentSnippet?: string;
  content?: string;
  summary?: string;
  link?: string;
  pubDate?: string;
  isoDate?: string;
  date?: string;
  "dc:date"?: string;
  [key: string]: unknown;
}

export interface RobustFeed {
  title?: string;
  link?: string;
  description?: string;
  items?: RobustFeedItem[];
  [key: string]: unknown;
}

export type FeedParseMode = "rss-parser" | "sanitized-xml" | "tolerant-xml";

export interface RobustRssResult {
  feed: RobustFeed;
  requestedUrl: string;
  resolvedUrl: string;
  parseMode: FeedParseMode;
  discovered: boolean;
}

interface FetchedDocument {
  body: string;
  finalUrl: string;
  contentType: string;
}

const parser = new Parser<Record<string, unknown>, Record<string, unknown>>({
  timeout: 20_000,
  customFields: {
    item: [["source", "source"], ["dc:creator", "creator"], ["dc:date", "dc:date"]],
  },
});

const resolvedFeedCache = new Map<string, string>();
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 NodeulNewsMonitor/1.0";

function normalizeHost(host: string): string {
  return host.toLowerCase().replace(/^www\./, "").replace(/\.$/, "");
}

function siteKey(host: string): string {
  const parts = normalizeHost(host).split(".");
  if (parts.length <= 2) return parts.join(".");
  const suffix2 = parts.slice(-2).join(".");
  const secondLevelCountrySuffixes = new Set([
    "co.kr", "or.kr", "go.kr", "ne.kr", "ac.kr", "re.kr", "pe.kr",
    "co.uk", "org.uk", "com.au", "com.cn", "com.sg", "co.jp",
  ]);
  return secondLevelCountrySuffixes.has(suffix2)
    ? parts.slice(-3).join(".")
    : parts.slice(-2).join(".");
}

function isPrivateIpv4(host: string): boolean {
  const parts = host.split(".").map(Number);
  return parts.length === 4 && (
    parts[0] === 0 || parts[0] === 10 || parts[0] === 127 ||
    (parts[0] === 169 && parts[1] === 254) ||
    (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
    (parts[0] === 192 && parts[1] === 168) || parts[0] >= 224
  );
}

function validateHttpUrl(value: string): URL {
  const url = new URL(value);
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) {
    throw new Error("지원하지 않는 RSS 주소입니다.");
  }
  const host = normalizeHost(url.hostname);
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
    throw new Error("로컬 RSS 주소는 허용되지 않습니다.");
  }
  if (isIP(host) && (isPrivateIpv4(host) || host === "::1" || /^(?:fc|fd|fe8|fe9|fea|feb|ff)/i.test(host))) {
    throw new Error("사설망 RSS 주소는 허용되지 않습니다.");
  }
  return url;
}

function relatedPublicationUrl(candidate: URL, base: URL): boolean {
  const candidateHost = normalizeHost(candidate.hostname);
  const baseHost = normalizeHost(base.hostname);
  return candidateHost === baseHost || siteKey(candidateHost) === siteKey(baseHost) ||
    candidateHost === "feeds.feedburner.com" || candidateHost.endsWith(".feedburner.com");
}

function detectEncoding(bytes: Buffer, contentType: string): string {
  const header = contentType.match(/charset\s*=\s*["']?([^;"'\s]+)/i)?.[1];
  const prefix = bytes.subarray(0, 1024).toString("ascii");
  const declaration = prefix.match(/<\?xml[^>]+encoding\s*=\s*["']([^"']+)/i)?.[1];
  const raw = (header || declaration || "utf-8").toLowerCase();
  if (["euc-kr", "ks_c_5601-1987", "ks-c-5601", "x-windows-949"].includes(raw)) return "cp949";
  return iconv.encodingExists(raw) ? raw : "utf-8";
}

async function fetchDocument(url: string, referer?: string): Promise<FetchedDocument> {
  const safe = validateHttpUrl(url);
  const response = await axios.get<ArrayBuffer>(safe.toString(), {
    responseType: "arraybuffer",
    timeout: 18_000,
    maxRedirects: 5,
    maxContentLength: 5_000_000,
    maxBodyLength: 5_000_000,
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "application/rss+xml,application/atom+xml,application/xml,text/xml,text/html;q=0.8,*/*;q=0.5",
      "Accept-Language": "ko-KR,ko;q=0.9,en;q=0.7",
      "Cache-Control": "no-cache",
      ...(referer ? { Referer: referer } : {}),
    },
    validateStatus: (status) => status >= 200 && status < 400,
  });
  const contentType = String(response.headers["content-type"] ?? "");
  const bytes = Buffer.isBuffer(response.data) ? response.data : Buffer.from(response.data);
  const body = iconv.decode(bytes, detectEncoding(bytes, contentType));
  const finalUrl =
    (response.request as { res?: { responseUrl?: string } } | undefined)?.res?.responseUrl || safe.toString();
  return { body, finalUrl, contentType };
}

export function sanitizeXml(xml: string): string {
  return xml
    .replace(/^\uFEFF/, "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
    .replace(/&(?!#\d+;|#x[0-9a-fA-F]+;|[a-zA-Z][a-zA-Z0-9]+;)/g, "&amp;");
}

function looksLikeHtml(value: string, contentType = ""): boolean {
  return /text\/html|application\/xhtml/i.test(contentType) || /<(?:!doctype\s+html|html|body)(?:\s|>)/i.test(value.slice(0, 4096));
}

function textFrom(node: cheerio.Cheerio<cheerio.AnyNode>, selectors: string[]): string {
  for (const selector of selectors) {
    const value = node.find(selector).first().text().trim();
    if (value) return value;
  }
  return "";
}

function tolerantParse(xml: string): RobustFeed {
  const $ = cheerio.load(xml, { xmlMode: true });
  const items: RobustFeedItem[] = [];
  $("item, entry").each((_, element) => {
    const node = $(element);
    const linkElement = node.find("link").first();
    const link = linkElement.attr("href")?.trim() || linkElement.text().trim() ||
      node.find("guid").first().text().trim();
    const date = textFrom(node, ["pubDate", "dc\\:date", "published", "updated", "date"]);
    const content = textFrom(node, ["content\\:encoded", "description", "summary", "content"]);
    const title = textFrom(node, ["title"]);
    if (!title && !link) return;
    items.push({
      title,
      link,
      pubDate: date,
      isoDate: date,
      "dc:date": date,
      content,
      contentSnippet: content,
      summary: content,
    });
  });
  if (items.length === 0 && !/<(?:rss|feed|rdf:RDF|channel)(?:\s|>)/i.test(xml.slice(0, 8192))) {
    throw new Error("RSS/Atom XML로 판별되지 않았습니다.");
  }
  return {
    title: $("channel > title, feed > title").first().text().trim(),
    link: $("channel > link, feed > link").first().attr("href") || $("channel > link").first().text().trim(),
    description: $("channel > description, feed > subtitle").first().text().trim(),
    items,
  };
}

export async function parseOfficialFeedText(
  raw: string,
  contentType = "application/xml",
): Promise<{ feed: RobustFeed; parseMode: FeedParseMode }> {
  if (looksLikeHtml(raw, contentType)) throw new Error("RSS 대신 HTML 페이지가 반환되었습니다.");
  try {
    const feed = await parser.parseString(raw);
    return { feed: feed as unknown as RobustFeed, parseMode: "rss-parser" };
  } catch (firstError) {
    const sanitized = sanitizeXml(raw);
    if (sanitized !== raw) {
      try {
        const feed = await parser.parseString(sanitized);
        return { feed: feed as unknown as RobustFeed, parseMode: "sanitized-xml" };
      } catch { /* tolerant XML fallback below */ }
    }
    try {
      return { feed: tolerantParse(sanitized), parseMode: "tolerant-xml" };
    } catch (secondError) {
      const first = firstError instanceof Error ? firstError.message : String(firstError);
      const second = secondError instanceof Error ? secondError.message : String(secondError);
      throw new Error(`${first}; 보정 파싱 실패: ${second}`);
    }
  }
}

export function discoverFeedUrlsFromHtml(html: string, baseUrl: string): string[] {
  const base = validateHttpUrl(baseUrl);
  const $ = cheerio.load(html);
  const found: string[] = [];
  const seen = new Set<string>();
  const add = (raw: string | undefined): void => {
    if (!raw) return;
    try {
      const url = validateHttpUrl(new URL(raw, base).toString());
      if (!relatedPublicationUrl(url, base)) return;
      url.hash = "";
      const value = url.toString();
      if (!seen.has(value)) { seen.add(value); found.push(value); }
    } catch { /* malformed link */ }
  };

  $('link[rel~="alternate"]').each((_, element) => {
    const type = ($(element).attr("type") || "").toLowerCase();
    const href = $(element).attr("href");
    if (/(rss|atom|xml)/.test(type) || /(?:rss|atom|feed)/i.test(href || "")) add(href);
  });
  $("a[href]").each((_, element) => {
    const href = $(element).attr("href");
    const text = $(element).text().trim();
    if (/(?:^|[\/_\-.])(rss|atom|feed)(?:[\/_\-.?]|$)/i.test(href || "") || /^(RSS|Atom|피드)$/i.test(text)) add(href);
  });
  return found.slice(0, 12);
}

function homepageCandidates(requested: URL): string[] {
  const origins = [requested.origin, `${requested.protocol}//${siteKey(requested.hostname)}`];
  return [...new Set(origins.map((origin) => `${origin.replace(/\/$/, "")}/`))];
}

function commonFeedCandidates(home: string): string[] {
  const paths = ["/rss", "/rss/", "/rss.xml", "/feed", "/feed.xml", "/atom.xml", "/rss/news.xml", "/rss/allArticle.xml"];
  return paths.map((path) => new URL(path, home).toString());
}

export async function loadOfficialRssFeed(requestedUrl: string): Promise<RobustRssResult> {
  const requested = validateHttpUrl(requestedUrl);
  const queued: Array<{ url: string; discovered: boolean; referer?: string }> = [];
  const seen = new Set<string>();
  const discoveryUrls: string[] = [];
  const errors: string[] = [];

  const enqueue = (url: string, discovered: boolean, referer?: string): void => {
    try {
      const normalized = validateHttpUrl(url).toString();
      if (seen.has(normalized)) return;
      seen.add(normalized);
      queued.push({ url: normalized, discovered, referer });
    } catch { /* invalid candidate */ }
  };

  const cached = resolvedFeedCache.get(requested.toString());
  if (cached) enqueue(cached, cached !== requested.toString());
  enqueue(requested.toString(), false);

  let attempts = 0;
  while (queued.length > 0 && attempts < 10) {
    const candidate = queued.shift()!;
    attempts++;
    try {
      const document = await fetchDocument(candidate.url, candidate.referer);
      if (looksLikeHtml(document.body, document.contentType)) {
        for (const feedUrl of discoverFeedUrlsFromHtml(document.body, document.finalUrl)) {
          enqueue(feedUrl, true, document.finalUrl);
          discoveryUrls.push(feedUrl);
        }
        errors.push(`${candidate.url}: HTML 페이지`);
        continue;
      }
      const parsed = await parseOfficialFeedText(document.body, document.contentType);
      resolvedFeedCache.set(requested.toString(), document.finalUrl);
      return {
        ...parsed,
        requestedUrl: requested.toString(),
        resolvedUrl: document.finalUrl,
        discovered: candidate.discovered || document.finalUrl !== requested.toString(),
      };
    } catch (error) {
      errors.push(`${candidate.url}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  for (const home of homepageCandidates(requested)) {
    if (attempts >= 14) break;
    try {
      attempts++;
      const document = await fetchDocument(home);
      for (const feedUrl of discoverFeedUrlsFromHtml(document.body, document.finalUrl)) {
        if (!discoveryUrls.includes(feedUrl)) discoveryUrls.push(feedUrl);
      }
    } catch (error) {
      errors.push(`${home}: 홈페이지 확인 실패 (${error instanceof Error ? error.message : String(error)})`);
    }
  }

  const homes = homepageCandidates(requested);
  const laterCandidates = [
    ...discoveryUrls,
    ...homes.flatMap(commonFeedCandidates),
  ];
  for (const url of laterCandidates) {
    if (attempts >= 20) break;
    if (seen.has(url)) continue;
    seen.add(url);
    attempts++;
    try {
      const document = await fetchDocument(url, homes[0]);
      if (looksLikeHtml(document.body, document.contentType)) continue;
      const parsed = await parseOfficialFeedText(document.body, document.contentType);
      resolvedFeedCache.set(requested.toString(), document.finalUrl);
      return {
        ...parsed,
        requestedUrl: requested.toString(),
        resolvedUrl: document.finalUrl,
        discovered: true,
      };
    } catch (error) {
      errors.push(`${url}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  throw new Error(`공식 RSS 확인 실패 (${errors.slice(0, 4).join(" | ")})`);
}

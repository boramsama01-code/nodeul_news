import * as cheerio from "cheerio";
import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import { readFileSync } from "node:fs";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import iconv from "iconv-lite";
import { extractArticleText } from "./articleText";
import { classifyProviderResponse, readProviderHealth } from "./providerHealth";
import { readState, writeState, usesDatabaseState } from "./persistentState";
import { ArticleData, cleanPublisherName, extractPressName, isPortalUrl, resolveMediaNameStrict, resolvePublisherHint } from "./crawlerUtils";

export interface ArticleIdentity {
  originalUrl: string;
  publisher: string | null;
  evidence: string[];
  status: "resolved" | "partial" | "unresolved" | "blocked";
  articleText?: string;
  textComplete?: boolean;
}
interface Address { address: string; family: number }
export interface PageResponse { status: number; headers: Record<string, string | undefined>; body: string }
interface CacheEntry { value: ArticleIdentity; checkedAt: number; expiresAt: number }
interface Alias { publisher: string; evidence: string[]; checkedAt: number; expiresAt: number }
interface CacheFile { version: 1; entries: Record<string, CacheEntry>; aliases: Record<string, Alias> }
export interface ResolverOptions {
  cachePath?: string | false;
  lookup?: (hostname: string) => Promise<Address[]>;
  transport?: (url: URL, addresses: Address[], signal: AbortSignal, maxBytes: number) => Promise<PageResponse>;
  now?: () => number;
  hostDelayMs?: number;
  timeoutMs?: number;
  maxHops?: number;
  concurrency?: number;
  maxBytes?: number;
  positiveTtlMs?: number;
  negativeTtlMs?: number;
}
export interface EnrichmentOptions { maxRequests?: number; network?: boolean }
interface Budget { remaining: number }
const DAY = 86_400_000;
const MAX_CACHE_ENTRIES = 5000;
const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

function normalizedUrl(input: string, base?: string): string {
  const url = new URL(input, base);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("blocked:unsafe-url");
  if (url.port && !["80", "443"].includes(url.port)) throw new Error("blocked:unsafe-port");
  url.hash = "";
  return url.href;
}

export function isPublicAddress(address: string): boolean {
  const ip = address.replace(/^\[|\]$/g, "");
  const family = isIP(ip);
  if (family === 4) {
    const [a, b, c] = ip.split(".").map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0 || (b === 88 && c === 99))) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113));
  }
  // Only global IPv6 unicast; exclude documentation, 6to4 and Teredo ranges.
  return family === 6 && /^[23]/i.test(ip) && !/^(?:2001:(?:db8|0):|2002:)/i.test(ip);
}

async function publicAddresses(url: URL, resolve: (hostname: string) => Promise<Address[]>): Promise<Address[]> {
  const host = url.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (host === "localhost" || /\.(?:localhost|local|internal|lan|home|test|invalid)$/i.test(host) || (!host.includes(".") && !isIP(host))) throw new Error("blocked:private-host");
  const addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await resolve(host);
  if (!addresses.length || addresses.some(item => !isPublicAddress(item.address))) throw new Error("blocked:private-address");
  return addresses;
}

// Pin the validated DNS result in the actual socket lookup; redirects are
// handled above this transport and must pass the same checks on every hop.
async function fetchPage(url: URL, addresses: Address[], signal: AbortSignal, maxBytes: number): Promise<PageResponse> {
  return await new Promise((resolve, reject) => {
    const address = addresses.find(item => item.family === 4) || addresses[0];
    const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(url, {
      method: "GET", signal, agent: false,
      lookup: ((_hostname: string, options: { all?: boolean }, callback: (...args: unknown[]) => void) => {
        if (options?.all) callback(null, [address]);
        else callback(null, address.address, address.family);
      }) as never,
      headers: { "User-Agent": "Mozilla/5.0 (compatible; NodeulNews/1.0)", Accept: "text/html,application/xhtml+xml", "Accept-Encoding": "gzip, deflate, br", "Accept-Language": "ko,en;q=0.8" },
    }, response => {
      const headers: Record<string, string | undefined> = {};
      for (const [name, value] of Object.entries(response.headers)) headers[name] = Array.isArray(value) ? value.join(", ") : value;
      if ((response.statusCode || 0) >= 300 && (response.statusCode || 0) < 400) {
        response.resume(); resolve({ status: response.statusCode!, headers, body: "" }); return;
      }
      if (Number(headers["content-length"] || 0) > maxBytes) { response.destroy(); reject(new Error("response-too-large")); return; }
      let stream: NodeJS.ReadableStream = response;
      const encoding = headers["content-encoding"];
      if (encoding === "gzip") stream = response.pipe(createGunzip());
      else if (encoding === "deflate") stream = response.pipe(createInflate());
      else if (encoding === "br") stream = response.pipe(createBrotliDecompress());
      const chunks: Buffer[] = [];
      let size = 0;
      stream.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > maxBytes) { request.destroy(new Error("response-too-large")); response.destroy(); return; }
        chunks.push(chunk);
      });
      stream.on("error", reject);
      response.on("error", reject);
      stream.on("end", () => {
        const bytes = Buffer.concat(chunks);
        const charset = headers["content-type"]?.match(/charset\s*=\s*["']?([\w-]+)/i)?.[1] || bytes.subarray(0, 4096).toString("ascii").match(/charset\s*=\s*["']?([\w-]+)/i)?.[1] || "utf-8";
        resolve({ status: response.statusCode || 0, headers, body: iconv.decode(bytes, iconv.encodingExists(charset) ? charset : "utf-8") });
      });
    });
    request.on("error", reject);
    request.end();
  });
}

export interface PageIdentity { publisher: string | null; evidence: string[]; aliasEligible: boolean; nextUrl?: string; nextEvidence?: string }
export function inspectPublisherPage(html: string, pageUrl: string): PageIdentity {
  const $ = cheerio.load(html);
  const signals: { name: string; evidence: string }[] = [];
  const add = (name: unknown, evidence: string) => {
    if (typeof name !== "string") return;
    const cleaned = cleanPublisherName(name);
    if (cleaned) signals.push({ name: cleaned, evidence });
  };
  const objects: Record<string, unknown>[] = [];
  const visit = (value: unknown, depth = 0): void => {
    if (depth > 12 || objects.length > 3000 || !value || typeof value !== "object") return;
    if (Array.isArray(value)) { for (const item of value) visit(item, depth + 1); return; }
    objects.push(value as Record<string, unknown>);
    for (const child of Object.values(value)) visit(child, depth + 1);
  };
  $("script[type='application/ld+json']").each((_i, element) => { try { visit(JSON.parse($(element).text())); } catch { /* Malformed structured data is optional. */ } });
  const byId = new Map(objects.filter(item => typeof item["@id"] === "string").map(item => [item["@id"], item]));
  const publisherName = (value: unknown): unknown => {
    if (typeof value === "string") return value.startsWith("http") || value.startsWith("#") ? publisherName(byId.get(value)) : value;
    if (Array.isArray(value)) return publisherName(value[0]);
    if (!value || typeof value !== "object") return undefined;
    const publisher = value as Record<string, unknown>;
    if (publisher.name) return publisher.name;
    const reference = byId.get(publisher["@id"]);
    return reference && reference !== publisher ? reference.name : undefined;
  };
  for (const object of objects) {
    const types = Array.isArray(object["@type"]) ? object["@type"] : [object["@type"]];
    if (types.some(type => typeof type === "string" && /(?:Article|WebPage|WebSite)$/.test(type))) add(publisherName(object.publisher), "schema.org:publisher");
  }
  $("meta").each((_i, element) => {
    const key = ($(element).attr("property") || $(element).attr("name") || "").toLowerCase();
    if (["og:site_name", "publisher", "dc.publisher", "dcterms.publisher"].includes(key)) add($(element).attr("content"), `meta:${key}`);
  });
  if (isPortalUrl(pageUrl)) {
    $(".media_end_head_top_logo img[alt], .press_logo img[alt], .link_cp img[alt], #kakaoServiceLogo img[alt]").each((_i, element) => add($(element).attr("alt"), "portal:press-logo"));
    $(".cp_name, .head_view .tit_cp").each((_i, element) => add($(element).text(), "portal:press-name"));
  }
  const publisher = signals[0]?.name || null;
  const evidence = signals.filter(item => item.name === publisher).map(item => item.evidence);
  // Learn only exact hosts, and only when schema and page metadata agree.
  // Shared blogging platforms never acquire a host-wide publisher identity.
  const host = new URL(pageUrl).hostname;
  const aliasEligible = !isPortalUrl(pageUrl) && !/(?:^|\.)(?:tistory\.com|wordpress\.com|blogspot\.com|medium\.com)$/i.test(host) && evidence.includes("schema.org:publisher") && evidence.some(item => item.startsWith("meta:"));
  const result: PageIdentity = { publisher, evidence: [...new Set(evidence)], aliasEligible };
  const candidate = (raw: string | undefined, evidenceName: string): boolean => {
    if (!raw) return false;
    try {
      const next = normalizedUrl(raw, pageUrl);
      if (next !== normalizedUrl(pageUrl)) { result.nextUrl = next; result.nextEvidence = evidenceName; return true; }
    } catch { /* Ignore non-HTTP links. */ }
    return false;
  };
  // Explicit article-origin links outrank surrounding related-story links.
  if (isPortalUrl(pageUrl)) {
    const original = $("a.media_end_head_origin_link[href], a.link_origin[href], a[data-original-url]").first();
    if (candidate(original.attr("data-original-url") || original.attr("href"), "portal:original-link")) return result;
    let found = false;
    $("a[href]").each((_i, element) => {
      if (!found && /^(?:기사\s*원문|원문\s*(?:보기|기사|보러가기)?|언론사\s*원문|View\s+original(?:\s+article)?|Read\s+(?:the\s+)?(?:full|original)\s+article)$/i.test($(element).text().trim())) found = candidate($(element).attr("href"), "portal:original-link");
    });
    if (found) return result;
  }
  const canonical = $("link[rel='canonical']").attr("href");
  if (canonical) {
    try {
      const target = new URL(canonical, pageUrl);
      const current = new URL(pageUrl);
      const sameBrand = resolveMediaNameStrict(current.href) && resolveMediaNameStrict(current.href) === resolveMediaNameStrict(target.href);
      if (target.pathname !== "/" && (target.hostname.replace(/^www\./, "") === current.hostname.replace(/^www\./, "") || sameBrand || (isPortalUrl(pageUrl) && !isPortalUrl(target.href)))) {
        if (candidate(canonical, "html:canonical")) return result;
      }
    } catch { /* Optional malformed canonical. */ }
  }
  const refresh = $("meta[http-equiv]").filter((_i, element) => ($(element).attr("http-equiv") || "").toLowerCase() === "refresh").attr("content");
  const refreshMatch = refresh?.match(/^\s*(\d+(?:\.\d+)?)\s*;\s*url\s*=\s*["']?(.+?)["']?\s*$/i);
  if (refreshMatch && Number(refreshMatch[1]) <= 10 && candidate(refreshMatch[2], "html:meta-refresh")) return result;
  // Recognize a script consisting solely of a literal redirect. Never execute JS.
  $("script:not([src])").each((_i, element) => {
    if (result.nextUrl) return;
    const script = $(element).text().trim();
    const match = script.match(/^(?:window\.)?location(?:\.href)?\s*=\s*(["'])(https?:\/\/[^"'<>\s]+)\1\s*;?$/i) || script.match(/^(?:window\.)?location\.(?:replace|assign)\s*\(\s*(["'])(https?:\/\/[^"'<>\s]+)\1\s*\)\s*;?$/i);
    if (match) candidate(match[2], "html:literal-redirect");
  });
  return result;
}

function portalTarget(url: string): string | undefined {
  const parsed = new URL(url);
  if (!isPortalUrl(url)) return undefined;
  if (/^(?:www\.)?google\.(?:com|co\.kr)$/.test(parsed.hostname) && parsed.pathname === "/url") return parsed.searchParams.get("url") || parsed.searchParams.get("q") || undefined;
  if (/(?:^|\.)naver\.com$/.test(parsed.hostname) && /\/p\/crd\/rd$/.test(parsed.pathname)) return parsed.searchParams.get("u") || parsed.searchParams.get("url") || undefined;
  if (parsed.hostname === "news.google.com") {
    const token = parsed.pathname.match(/\/(?:articles|read)\/([A-Za-z0-9_-]+)$/)?.[1];
    if (token) {
      // Older Google News URLs embed the original URL in a protobuf string.
      // New opaque AU_yqL tokens require Google's dynamic service: leave partial.
      const decoded = Buffer.from(token, "base64url").toString("utf8");
      return decoded.match(/https?:\/\/[^\s\x00-\x20\x7f-\uffff<>"\\]+/)?.[0];
    }
  }
  return undefined;
}

export function formatMediaName(source: string, publisher: string | null, currentName = ""): string {
  const press = cleanPublisherName(publisher || "") || "기타";
  if (source === "google_news_rss" || source === "google_news_web") return `구글뉴스(${press})`;
  if (source.startsWith("naver")) return `${currentName.startsWith("네이버뉴스(") ? "네이버뉴스" : "네이버"}(${press})`;
  if (source.startsWith("daum")) return `다음뉴스(${press})`;
  return press === "기타" ? currentName || "기타" : press;
}

export function createPublisherResolver(options: ResolverOptions = {}) {
  const databaseCache = options.cachePath === undefined && usesDatabaseState();
  const cachePath = options.cachePath === false ? false : options.cachePath || join(process.env.DATA_DIR || ".local", "publisher-cache.json");
  const now = options.now || Date.now;
  const entries = new Map<string, CacheEntry>();
  const aliases = new Map<string, Alias>();
  const pending = new Map<string, Promise<ArticleIdentity>>();
  const hostNextStart = new Map<string, number>();
  const blockedHosts = new Map<string, number>();
  const dirtyEntries = new Map<string, CacheEntry>();
  const dirtyAliases = new Map<string, Alias>();
  let flushTimer: ReturnType<typeof setTimeout> | undefined;
  let active = 0;
  const queue: (() => void)[] = [];
  const concurrency = Math.max(1, Math.min(4, options.concurrency ?? 3));
  const loadCache = (text: string): CacheFile => {
    const cache = JSON.parse(text) as CacheFile;
    if (cache.version !== 1 || !cache.entries || !cache.aliases) throw new Error("invalid-cache");
    return cache;
  };
  if (cachePath && !databaseCache) {
    try {
      const disk = loadCache(readFileSync(cachePath, "utf8"));
      for (const [key, value] of Object.entries(disk.entries)) if (value.expiresAt > now()) entries.set(key, value);
      for (const [key, value] of Object.entries(disk.aliases)) if (value.expiresAt > now()) aliases.set(key, value);
    } catch { /* Empty or invalid cache never prevents collection. */ }
  }
  let cacheLoaded: Promise<void> | undefined;
  async function ensureCacheLoaded(): Promise<void> {
    if (!databaseCache) return;
    cacheLoaded ??= (async () => {
      const saved = await readState<CacheFile>("publisher-cache");
      if (!saved) return;
      const disk = loadCache(JSON.stringify(saved));
      for (const [key, value] of Object.entries(disk.entries)) if (value.expiresAt > now()) entries.set(key, value);
      for (const [key, value] of Object.entries(disk.aliases)) if (value.expiresAt > now()) aliases.set(key, value);
    })();
    try { await cacheLoaded; } catch (error) { cacheLoaded = undefined; throw error; }
  }
  let flushTask: Promise<void> = Promise.resolve();
  function flush(): Promise<void> {
    flushTask = flushTask.catch(() => {}).then(flushOnce);
    return flushTask;
  }
  async function flushOnce(): Promise<void> {
    if (!cachePath || (!dirtyEntries.size && !dirtyAliases.size)) return;
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = undefined; }
    if (databaseCache) {
      await ensureCacheLoaded();
      const changedEntries = new Map(dirtyEntries), changedAliases = new Map(dirtyAliases);
      const disk: CacheFile = {
        version: 1,
        entries: Object.fromEntries([...entries].filter(([,v]) => v.expiresAt > now()).sort((a,b) => b[1].checkedAt-a[1].checkedAt).slice(0,MAX_CACHE_ENTRIES)),
        aliases: Object.fromEntries([...aliases].filter(([,v]) => v.expiresAt > now()).slice(-1000)),
      };
      await writeState("publisher-cache", disk);
      for (const [key,value] of changedEntries) if (dirtyEntries.get(key) === value) dirtyEntries.delete(key);
      for (const [key,value] of changedAliases) if (dirtyAliases.get(key) === value) dirtyAliases.delete(key);
      return;
    }
    await mkdir(dirname(cachePath), { recursive: true });
    const lockPath = `${cachePath}.lock`;
    let lock;
    for (let attempt = 0; attempt < 25; attempt++) {
      try { lock = await open(lockPath, "wx"); break; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") return;
        await wait(20);
      }
    }
    if (!lock) return;
    const temp = `${cachePath}.${process.pid}.tmp`;
    try {
      let disk: CacheFile = { version: 1, entries: {}, aliases: {} };
      try { disk = loadCache(await readFile(cachePath, "utf8")); } catch { /* First save. */ }
      const changedEntries = new Map(dirtyEntries);
      const changedAliases = new Map(dirtyAliases);
      for (const [key, value] of changedEntries) if (!disk.entries[key] || disk.entries[key].checkedAt <= value.checkedAt) disk.entries[key] = value;
      for (const [key, value] of changedAliases) if (!disk.aliases[key] || disk.aliases[key].checkedAt <= value.checkedAt) disk.aliases[key] = value;
      disk.entries = Object.fromEntries(Object.entries(disk.entries).filter(([, value]) => value.expiresAt > now()).sort((a, b) => b[1].checkedAt - a[1].checkedAt).slice(0, MAX_CACHE_ENTRIES));
      disk.aliases = Object.fromEntries(Object.entries(disk.aliases).filter(([, value]) => value.expiresAt > now()).slice(-1000));
      const file = await open(temp, "w");
      try { await file.writeFile(JSON.stringify(disk)); } finally { await file.close(); }
      await rename(temp, cachePath);
      for (const [key, value] of changedEntries) if (dirtyEntries.get(key) === value) dirtyEntries.delete(key);
      for (const [key, value] of changedAliases) if (dirtyAliases.get(key) === value) dirtyAliases.delete(key);
    } finally { await lock.close(); await unlink(lockPath).catch(() => {}); await unlink(temp).catch(() => {}); }
  }
  function scheduleFlush() {
    if (!cachePath || flushTimer) return;
    flushTimer = setTimeout(() => { flushTimer = undefined; void flush().catch(() => {}); }, 200);
    flushTimer.unref();
  }
  async function requestPage(url: URL, budget: Budget): Promise<PageResponse> {
    if ((blockedHosts.get(url.hostname) || 0) > now()) throw new Error("host-cooldown");
    if (url.hostname === "news.google.com") {
      const state = (await readProviderHealth()).google_news;
      if (state?.blockedUntil && Date.parse(state.blockedUntil) > now()) throw new Error("provider-cooldown");
    }
    if (budget.remaining <= 0) throw new Error("request-budget");
    budget.remaining--;
    if (active >= concurrency) await new Promise<void>(resolve => queue.push(resolve));
    else active++;
    const delayMs = Math.max(0, options.hostDelayMs ?? 600);
    const start = Math.max(Date.now(), hostNextStart.get(url.hostname) || 0);
    hostNextStart.set(url.hostname, start + delayMs);
    try {
      await wait(Math.max(0, start - Date.now()));
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 8000);
      try {
        return await Promise.race([
          (async () => {
            const addresses = await publicAddresses(url, options.lookup || (async host => await lookup(host, { all: true })));
            if (controller.signal.aborted) throw new Error("request-timeout");
            return await (options.transport || fetchPage)(url, addresses, controller.signal, options.maxBytes ?? 1_500_000);
          })(),
          new Promise<never>((_resolve, reject) => controller.signal.addEventListener("abort", () => reject(new Error("request-timeout")), { once: true })),
        ]);
      } finally { clearTimeout(timer); }
    } finally {
      const next = queue.shift();
      if (next) next(); else active--;
    }
  }
  // Content checks share DNS/redirect safeguards, pacing, budgets and the disk
  // cache with publisher lookup. They never replace the stored collection URL.
  async function resolveArticleContent(input: string, controls: EnrichmentOptions & { budget?: Budget } = {}): Promise<ArticleIdentity> {
    await ensureCacheLoaded();
    let url: string;
    try { url = normalizedUrl(input); }
    catch { return {originalUrl: input, publisher: null, evidence: ["blocked:unsafe-url"], status: "blocked"}; }
    const key = `body:${url}`;
    const cached = entries.get(key);
    if (cached && cached.expiresAt > now()) return cached.value;
    if (pending.has(key)) return pending.get(key)!;
    const budget = controls.budget || {remaining: controls.network === false ? 0 : controls.maxRequests ?? 5};
    const task = (async (): Promise<ArticleIdentity> => {
      const seen = new Set<string>();
      let value: ArticleIdentity = {originalUrl: input, publisher: null, evidence: [], status: "unresolved"};
      try {
        for (let hop = 0; hop < (options.maxHops ?? 4); hop++) {
          if (seen.has(url)) throw new Error("redirect-loop");
          seen.add(url);
          const embedded = portalTarget(url);
          if (embedded) { url = normalizedUrl(embedded, url); continue; }
          const parsed = new URL(url);
          const page = await requestPage(parsed, budget);
          if (page.status >= 300 && page.status < 400 && page.headers.location) { url = normalizedUrl(page.headers.location, url); continue; }
          const restriction = classifyProviderResponse(page.status, page.body);
          if ([403,429,503].includes(page.status) || ["automated", "challenge"].includes(restriction.kind)) {
            blockedHosts.set(parsed.hostname, now() + 60 * 60_000);
            throw new Error(`접근 제한: ${restriction.reason}`);
          }
          if (page.status < 200 || page.status >= 300) throw new Error(`HTTP ${page.status}`);
          if (page.headers["content-type"] && !/html|xml|text\//i.test(page.headers["content-type"]!)) throw new Error("non-html");
          const identity = inspectPublisherPage(page.body, url);
          const body = extractArticleText(page.body);
          // Google relay pages are not article bodies. Naver/Daum article views are.
          if (parsed.hostname !== "news.google.com" && body.text) value = {...value, originalUrl: url, publisher: identity.publisher || resolveMediaNameStrict(url), articleText: body.text, textComplete: body.complete, status: "partial"};
          if (value.textComplete || (!isPortalUrl(url) && value.articleText)) return {...value, status: "resolved", evidence: ["article-page"]};
          if (identity.nextUrl) { url = identity.nextUrl; continue; }
          return {...value, evidence: [body.text ? "본문 추출 불완전" : "기사 본문을 찾지 못함"]};
        }
        return {...value, evidence: ["redirect-limit"]};
      } catch (error) { return {...value, evidence: [error instanceof Error ? error.message : String(error)]}; }
    })();
    pending.set(key, task);
    try {
      const value = await task;
      if (!value.evidence.includes("request-budget")) {
        const ttl = value.articleText && value.textComplete ? options.positiveTtlMs ?? 7 * DAY : options.negativeTtlMs ?? 3_600_000;
        const entry = {value, checkedAt: now(), expiresAt: now() + ttl};
        entries.set(key, entry); dirtyEntries.set(key, entry); scheduleFlush();
        if (entries.size > MAX_CACHE_ENTRIES) entries.delete(entries.keys().next().value!);
      }
      return value;
    } finally { pending.delete(key); }
  }
  async function resolveUncached(input: string, budget: Budget): Promise<ArticleIdentity> {
    let url = input;
    let publisher: string | null = null;
    const evidence: string[] = [];
    const seen = new Set<string>();
    let verifiedUrl = input;
    for (let hop = 0; hop <= (options.maxHops ?? 4); hop++) {
      if (seen.has(url)) return { originalUrl: verifiedUrl, publisher, evidence: [...evidence, "redirect-loop"], status: publisher ? "partial" : "unresolved" };
      seen.add(url);
      const parsed = new URL(url);
      const mapped = resolveMediaNameStrict(url);
      const alias = aliases.get(parsed.hostname);
      if (mapped || (alias && alias.expiresAt > now())) {
        // A domain mapping identifies the publisher, but is not proof that a
        // newly discovered redirect target is reachable. Validate its host too.
        try { await publicAddresses(parsed, options.lookup || (async host => await lookup(host, { all: true }))); }
        catch (error) { return { originalUrl: verifiedUrl, publisher, evidence: [...evidence, String((error as Error).message)], status: "blocked" }; }
        return { originalUrl: url, publisher: mapped || alias!.publisher, evidence: [...evidence, mapped ? "domain-map" : "verified-host-cache"], status: "resolved" };
      }
      const embedded = portalTarget(url);
      if (embedded) {
        try { url = normalizedUrl(embedded, url); evidence.push("portal:embedded-original-url"); continue; }
        catch { /* Fetch the portal page when its embedded target is invalid. */ }
      }
      if (hop === (options.maxHops ?? 4)) return { originalUrl: verifiedUrl, publisher, evidence: [...evidence, "redirect-limit"], status: publisher ? "partial" : "unresolved" };
      try {
        const page = await requestPage(parsed, budget);
        verifiedUrl = url;
        if (page.status >= 300 && page.status < 400 && page.headers.location) {
          url = normalizedUrl(page.headers.location, url); evidence.push(`http:${page.status}`); continue;
        }
        if (page.status < 200 || page.status >= 300) return { originalUrl: url, publisher, evidence: [...evidence, `http:${page.status}`], status: publisher ? "partial" : "unresolved" };
        if (page.headers["content-type"] && !/html|xml|text\//i.test(page.headers["content-type"]!)) return { originalUrl: url, publisher, evidence: [...evidence, "non-html"], status: publisher ? "partial" : "unresolved" };
        const identity = inspectPublisherPage(page.body, url);
        if (identity.publisher) { publisher = identity.publisher; evidence.push(...identity.evidence); }
        if (identity.aliasEligible && identity.publisher) {
          const value: Alias = { publisher: identity.publisher, evidence: identity.evidence, checkedAt: now(), expiresAt: now() + 30 * DAY };
          aliases.set(parsed.hostname, value); dirtyAliases.set(parsed.hostname, value); scheduleFlush();
        }
        if (identity.nextUrl) { url = identity.nextUrl; evidence.push(identity.nextEvidence!); continue; }
        return { originalUrl: url, publisher, evidence: [...evidence, ...(!publisher ? [isPortalUrl(url) ? "portal:dynamic-or-no-original-link" : "no-publisher-metadata"] : [])], status: publisher ? isPortalUrl(url) ? "partial" : "resolved" : "unresolved" };
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        return { originalUrl: verifiedUrl, publisher, evidence: [...evidence, reason], status: reason.startsWith("blocked:") ? "blocked" : publisher ? "partial" : "unresolved" };
      }
    }
    return { originalUrl: verifiedUrl, publisher, evidence, status: "unresolved" };
  }
  async function resolveArticleIdentity(input: string, fallbackName?: string, controls: EnrichmentOptions & { budget?: Budget } = {}): Promise<ArticleIdentity> {
    await ensureCacheLoaded();
    const rawFallback = extractPressName(fallbackName || "");
    const fallback = resolvePublisherHint(rawFallback) || null;
    const decorate = (value: ArticleIdentity): ArticleIdentity => {
      const publisher = cleanPublisherName(value.publisher || "") || null;
      return publisher || !fallback || value.status === "blocked"
        ? { ...value, publisher, evidence: [...value.evidence] }
        : { ...value, publisher: fallback, evidence: [...value.evidence, "collection:publisher-label"], status: "partial" };
    };
    let url: string;
    try { url = normalizedUrl(input); } catch { return { originalUrl: input, publisher: null, evidence: ["blocked:unsafe-url"], status: "blocked" }; }
    const mapped = resolveMediaNameStrict(url);
    // No network is needed to identify a known publisher's existing article URL.
    if (mapped) return { originalUrl: url, publisher: mapped, evidence: ["domain-map"], status: "resolved" };
    const cached = entries.get(url);
    if (cached && cached.expiresAt > now()) return decorate(cached.value);
    const alias = aliases.get(new URL(url).hostname);
    if (alias && alias.expiresAt > now()) return { originalUrl: url, publisher: alias.publisher, evidence: ["verified-host-cache"], status: "resolved" };
    if (!isPortalUrl(url) && fallback) return decorate({ originalUrl: url, publisher: null, evidence: [], status: "partial" });
    if (controls.network === false || controls.maxRequests === 0 || controls.budget?.remaining === 0) return decorate({ originalUrl: url, publisher: null, evidence: ["network-skipped"], status: "unresolved" });
    const existing = pending.get(url);
    if (existing) return decorate(await existing);
    const task = resolveUncached(url, controls.budget || { remaining: controls.maxRequests ?? 5 });
    pending.set(url, task);
    try {
      const value = await task;
      if (!value.evidence.includes("request-budget")) {
        const ttl = value.status === "resolved" ? options.positiveTtlMs ?? 7 * DAY : options.negativeTtlMs ?? 3_600_000;
        const entry = { value, checkedAt: now(), expiresAt: now() + ttl };
        entries.set(url, entry); dirtyEntries.set(url, entry); scheduleFlush();
        if (entries.size > MAX_CACHE_ENTRIES) entries.delete(entries.keys().next().value!);
      }
      return decorate(value);
    } finally { pending.delete(url); }
  }
  async function enrichArticles<T extends ArticleData>(articles: T[], controls: EnrichmentOptions = {}): Promise<T[]> {
    const output = [...articles];
    const budget = { remaining: controls.network === false ? 0 : Math.max(0, controls.maxRequests ?? 80) };
    let index = 0;
    const worker = async () => {
      while (index < articles.length) {
        const current = index++;
        const article = articles[current];
        const suffix = article.source === "google_news_rss" ? cleanPublisherName(article.title.split(" - ").slice(-1)[0]) : "";
        // Legacy RSS descriptions retain the main headline and its source separated by two spaces.
        // Only inspect the first item: related-story publishers must never label the main article.
        const firstLine = (article.content || "").split(/\r?\n/)[0].trim();
        const parts = firstLine.split(/[ \u00a0]{2,}/);
        const headline = article.title.replace(/ - [^-]+$/, "").trim();
        const descriptionSource = article.source === "google_news_rss" && parts.length === 2 &&
          (parts[0].trim() === article.title.trim() || parts[0].trim() === headline) ? parts[1].trim() : "";
        const descriptionHint = resolvePublisherHint(descriptionSource);
        const rssHint = descriptionHint || (article.title.includes(" - ") && suffix && firstLine.endsWith(suffix) ? suffix : "");
        const identity = await resolveArticleIdentity(article.url, rssHint ? formatMediaName(article.source,rssHint) : article.mediaName, rssHint ? {network:false} : { ...controls, budget });
        output[current] = { ...article, url: article.url, mediaName: formatMediaName(article.source, identity.publisher || cleanPublisherName(extractPressName(article.mediaName)), article.mediaName) };
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, articles.length) }, worker));
    await flush().catch(() => {});
    return output;
  }
  return { resolveArticleIdentity, resolveArticleContent, enrichArticles, flush };
}

let sharedResolver: ReturnType<typeof createPublisherResolver> | undefined;
const shared = () => sharedResolver ||= createPublisherResolver();
export const resolveArticleIdentity = (url: string, fallbackName?: string, options?: EnrichmentOptions) => shared().resolveArticleIdentity(url, fallbackName, options);
export const enrichArticles = <T extends ArticleData>(articles: T[], options?: EnrichmentOptions) => shared().enrichArticles(articles, options);
export const flushPublisherCache = () => shared().flush();
export const resolveArticleContent = (url: string, options?: EnrichmentOptions & {budget?: Budget}) => shared().resolveArticleContent(url, options);

export { backfillUnknownPublishers, enrichArticlePublisher, extractPublisherFromHtml, formatResolvedMediaName, isUnknownPublisher, resolvePublisherFromUrl } from "./publisherBackfill";

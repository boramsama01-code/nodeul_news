import test from "node:test";
import assert from "node:assert/strict";
import axios from "axios";
import Parser from "rss-parser";
import { crawlWarnings, googleFeedUrl, kstDate, mapConcurrent, parseRssPublishedAt, validateDateRange } from "./crawlRuntime";
import { crawlDaumNews, crawlNaverNews, crawlNaverWebSearch, crawlSource, parseNaverDateText } from "./crawlerSources";
import { COLLECTION_KEYWORDS, GOOGLE_NEWS_QUERY } from "./newsRelevance";
import { GOOGLE_NEWS_SOURCES } from "./rssFeedList";

test("relative publication times use Korean calendar days, including midnight", () => {
  const now = new Date("2026-09-10T15:10:00Z");
  assert.equal(kstDate(now), "2026-09-11");
  assert.equal(parseNaverDateText("5분 전", now), "2026-09-11");
  assert.equal(parseNaverDateText("20분 전", now), "2026-09-10");
  assert.equal(parseNaverDateText("1시간 전", now), "2026-09-10");
  assert.equal(parseNaverDateText("어제", now), "2026-09-10");
});

test("invalid and reversed dates fail before starting network requests", () => {
  assert.throws(() => validateDateRange("2026-02-30", "2026-03-01"));
  assert.throws(() => validateDateRange("2026-09-11", "2026-09-10"));
  validateDateRange("2024-02-29", "2024-02-29");
});

test("Korean RSS dates use source timestamps in KST instead of parser-derived server time", () => {
  assert.equal(parseRssPublishedAt({pubDate:"2026-10-22 13:54:00", isoDate:"2026-10-22T20:54:00Z"})?.toISOString(), "2026-10-22T04:54:00.000Z");
  assert.equal(parseRssPublishedAt({"dc:date":"2026-01-01 00:10:00", isoDate:"2026-01-01T08:10:00Z"})?.toISOString(), "2025-12-31T15:10:00.000Z");
  assert.equal(parseRssPublishedAt({date:"2024-02-29T23:59:59"})?.toISOString(), "2024-02-29T14:59:59.000Z");
  assert.equal(parseRssPublishedAt({pubDate:"Thu, 22 Oct 2026 14:05:05 +0900"})?.toISOString(), "2026-10-22T05:05:05.000Z");
  assert.equal(parseRssPublishedAt({isoDate:"2026-10-22T05:05:05Z"})?.toISOString(), "2026-10-22T05:05:05.000Z");
  for (const pubDate of ["2026-02-30 13:00:00", "2026-02-30T13:00:00Z", "2026-10-22 24:01:00", "2026-10-22 13:61:00", "invalid"]) {
    assert.equal(parseRssPublishedAt({pubDate, isoDate:"2026-10-22T01:00:00Z"}), null);
  }
  assert.equal(parseRssPublishedAt({}), null);
});

test("RSS date filtering respects the Korean midnight boundary and rejects invalid source dates", async () => {
  const previousParse = Parser.prototype.parseURL;
  Parser.prototype.parseURL = (async () => ({ items: [
    {title:"노들섬 신년 행사", link:"https://example.com/new-year", "dc:date":"2026-01-01 00:10:00", isoDate:"2026-01-01T08:10:00Z"},
    {title:"노들섬 전날 행사", link:"https://example.com/previous-day", pubDate:"2025-12-31 23:59:00"},
    {title:"노들섬 잘못된 날짜", link:"https://example.com/invalid-day", pubDate:"2026-01-32 12:00:00", isoDate:"2026-01-01T03:00:00Z"},
  ] })) as typeof Parser.prototype.parseURL;
  try {
    const articles = await crawlSource({name:"시험 언론사", method:"rss_direct", url:"https://example.com/rss", domain:"example.com"}, "2026-01-01", "2026-01-01");
    assert.equal(articles.length, 1);
    assert.equal(articles[0].url, "https://example.com/new-year");
    assert.equal(articles[0].publishedAt.toISOString(), "2025-12-31T15:10:00.000Z");
  } finally { Parser.prototype.parseURL = previousParse; }
});

test("Google query includes the requested historical interval and press filter", () => {
  for (const source of GOOGLE_NEWS_SOURCES) {
    const url = new URL(googleFeedUrl(source.url, "2026-01-01", "2026-01-31"));
    const scope = source.domain === "news.google.com" ? "" : ` site:${source.domain}`;
    assert.equal(url.searchParams.get("q"), `(${GOOGLE_NEWS_QUERY})${scope} after:2025-12-31 before:2026-02-01`);
    assert.equal(url.searchParams.get("hl"), "ko");
  }
});

test("Google and direct RSS reject related road names and retain each approved term", async () => {
  const previousParse = Parser.prototype.parseURL;
  Parser.prototype.parseURL = (async () => ({ items: [
    ...COLLECTION_KEYWORDS.map((keyword, index) => ({title:`${keyword} 행사`, link:`https://example.com/${index}`, pubDate:"2026-01-10T03:00:00Z"})),
    {title:"노들길 통제와 노들로 교통", link:"https://example.com/road", pubDate:"2026-01-10T03:00:00Z"},
  ] })) as typeof Parser.prototype.parseURL;
  try {
    for (const method of ["google_news_rss", "rss_direct"] as const) {
      const articles = await crawlSource({name:"시험 언론사", method, url:"https://example.com/rss", domain:"example.com"}, "2026-01-01", "2026-01-31");
      assert.equal(articles.length, COLLECTION_KEYWORDS.length);
      assert.ok(articles.every(article => article.source === method));
      assert.ok(articles.every(article => !article.url.endsWith("/road")));
    }
  } finally { Parser.prototype.parseURL = previousParse; }
});

test("RSS requests never exceed the concurrency limit", async () => {
  let active = 0, peak = 0;
  const result = await mapConcurrent([1,2,3,4,5,6], 2, async value => {
    active++; peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 5));
    active--;
    return value * 2;
  });
  assert.equal(peak, 2);
  assert.deepEqual(result, [2,4,6,8,10,12]);
});

test("multi-month Naver request fetches each keyword once without pretending dates bypass its cap", async () => {
  const previousGet = axios.get;
  const previousId = process.env.NAVER_CLIENT_ID;
  const previousSecret = process.env.NAVER_CLIENT_SECRET;
  process.env.NAVER_CLIENT_ID = "test";
  process.env.NAVER_CLIENT_SECRET = "test";
  const queries: string[] = [];
  axios.get = (async (_url: string, config: {params: {start: number; query: string}}) => {
    queries.push(config.params.query);
    assert.equal(config.params.start, 1);
    return { data: { items: [
      { title:`${config.params.query} 행사`, description:"행사 소식", originallink:`https://example.com/news/${queries.length}`, pubDate:"2026-08-01T03:00:00Z" },
      { title:"노들길 교통", description:"노들로 공사", originallink:"https://example.com/road", pubDate:"2026-08-01T03:00:00Z" },
    ] } };
  }) as typeof axios.get;
  try {
    const articles = await crawlNaverNews("2026-01-01", "2026-09-11");
    assert.deepEqual(queries, [...COLLECTION_KEYWORDS]);
    assert.equal(articles.length, COLLECTION_KEYWORDS.length);
  } finally {
    axios.get = previousGet;
    if (previousId === undefined) delete process.env.NAVER_CLIENT_ID; else process.env.NAVER_CLIENT_ID = previousId;
    if (previousSecret === undefined) delete process.env.NAVER_CLIENT_SECRET; else process.env.NAVER_CLIENT_SECRET = previousSecret;
  }
});

test("portal pagination can accept a later relevant snippet for a previously rejected URL", async () => {
  const previousGet = axios.get;
  const pageCalls = { daum: 0, naver: 0 };
  axios.get = (async (url: string, config: {params: {q?: string; query?: string; page?: number; start?: number}}) => {
    if ((config.params.q ?? config.params.query) !== COLLECTION_KEYWORDS[0]) {
      return { data: "검색결과가 없습니다" };
    }
    const daum = url.includes("daum.net");
    pageCalls[daum ? "daum" : "naver"]++;
    const page = daum ? config.params.page : config.params.start;
    const snippet = page === 1 ? "노들길 교통 안내" : "노들섬 행사 안내";
    return { data: daum
      ? `<li><div class="item-bundle-mid"><div class="item-title"><strong><a href="https://v.daum.net/v/20260110120000123">행사 안내</a></strong></div><div class="item-contents"><span class="conts-desc">${snippet}</span></div></div></li>`
      : `<div>2026.01.10.</div><a data-heatmap-target=".tit" href="https://example.com/news">행사 안내</a><a data-heatmap-target=".body" href="https://example.com/news">${snippet}</a>` };
  }) as typeof axios.get;
  try {
    const daum = await crawlDaumNews("2026-01-01", "2026-01-31");
    const naver = await crawlNaverWebSearch("2026-01-01", "2026-01-31");
    assert.equal(daum.length, 1);
    assert.equal(naver.length, 1);
    assert.equal(daum[0].content, "노들섬 행사 안내");
    assert.equal(naver[0].content, "노들섬 행사 안내");
    assert.deepEqual(pageCalls, { daum: 3, naver: 3 });
  } finally { axios.get = previousGet; }
});

test("Daum paginates past mixed, unknown, and malformed dates but stops on an entirely old page", async t => {
  const previousTimeout = globalThis.setTimeout;
  t.mock.method(globalThis, "setTimeout", (callback: () => void) => previousTimeout(callback, 0));
  const item = (url: string) => `<li><div class="item-bundle-mid"><div class="item-title"><strong><a href="${url}">노들섬 행사</a></strong></div></div></li>`;
  const old = item("https://v.daum.net/v/20260301120000123");
  const next = item("https://v.daum.net/v/20260402120000123");

  for (const [other, expectedCount, expectedCalls] of [
    [item("https://v.daum.net/v/20260401120000123"), 2, 3],
    [item("https://example.com/no-publication-date"), 1, 3],
    [item("https://v.daum.net/v/20260230120000123"), 1, 3],
    [item("https://v.daum.net/v/20260302120000123"), 0, 1],
  ] as const) {
    let calls = 0;
    const mockGet = t.mock.method(axios, "get", async (_url: string, config: {params: {q: string; page: number}}) => {
      if (config.params.q !== COLLECTION_KEYWORDS[0]) return { data: "검색결과가 없습니다" };
      calls++;
      return {data: config.params.page === 1 ? old + other : config.params.page === 2 ? next : old};
    });
    const articles = await crawlDaumNews("2026-04-01", "2026-04-30");
    assert.equal(articles.length, expectedCount);
    assert.equal(calls, expectedCalls);
    mockGet.mock.restore();
  }
});

test("full final portal pages record pagination coverage limits", async t => {
  const previousTimeout = globalThis.setTimeout;
  t.mock.method(globalThis, "setTimeout", (callback: () => void) => previousTimeout(callback, 0));
  const pageCalls = {daum: 0, naver: 0};
  t.mock.method(axios, "get", async (url: string, config: {params: {q?: string; query?: string; page?: number; start?: number}}) => {
    if ((config.params.q ?? config.params.query) !== COLLECTION_KEYWORDS[0]) return {data: "검색결과가 없습니다"};
    const daum = url.includes("daum.net");
    pageCalls[daum ? "daum" : "naver"]++;
    const page = daum ? config.params.page! : config.params.start!;
    return {data: Array.from({length: 10}, (_, index) => daum
      ? `<li><div><div class="item-title"><a href="https://v.daum.net/v/202601101200${page * 10 + index}">노들섬 행사 ${page}-${index}</a></div></div></li>`
      : `<div>2026.01.10.</div><a data-heatmap-target=".tit" href="https://example.com/${page}/${index}">노들섬 행사 ${page}-${index}</a>`).join("")};
  });
  const warnings: string[] = [];
  await crawlWarnings.run(warnings, async () => {
    assert.equal((await crawlDaumNews("2026-01-01", "2026-01-31")).length, 200);
    assert.equal((await crawlNaverWebSearch("2026-01-01", "2026-01-31")).length, 1000);
  });
  assert.deepEqual(pageCalls, {daum: 20, naver: 100});
  assert.ok(warnings.some(warning => /다음.*20페이지 탐색 한도/.test(warning)));
  assert.ok(warnings.some(warning => /네이버 웹.*100페이지 탐색 한도/.test(warning)));
});

test("restart catches up after downtime and overlaps recent days", async () => {
  process.env.DATABASE_URL ??= "postgres://localhost/test";
  const { catchUpRange } = await import("./scheduler");
  const now = new Date("2026-09-10T15:10:00Z");
  assert.deepEqual(catchUpRange(now), {start:"2026-09-08",end:"2026-09-11"});
  assert.deepEqual(catchUpRange(now, "2026-09-01T03:00:00Z"), {start:"2026-08-31",end:"2026-09-11"});
});

test("a failed insert is not marked as a duplicate and collection reports storage failure", async () => {
  process.env.DATABASE_URL ??= "postgres://localhost/test";
  const { runCrawlJob } = await import("./crawlOrchestrator");
  let inserts = 0;
  const updates: Record<string, unknown>[] = [];
  const fakeDb = {
    select: () => ({from: async () => []}),
    update: () => ({set: (value: Record<string, unknown>) => {updates.push(value); return {where: async () => undefined};}}),
    insert: () => ({values: async () => { if (++inserts === 1) throw new Error("storage offline"); }}),
  };
  const article = {title:"노들섬 행사",content:"노들섬",url:"https://example.com/news",publishedAt:new Date("2026-09-11T03:00:00Z"),mediaName:"테스트",isNegative:false,isSelfPR:false,source:"naver_api"};
  await runCrawlJob("test", "2026-09-11", "2026-09-11", {
    db: fakeDb as never, analyzeArticleSentiment: async () => false,
    crawlNaverNews: async () => [article, article], crawlNaverWebSearch: async () => [],
    crawlDaumNews: async () => [], crawlAllSources: async () => [],
  });
  assert.equal(inserts, 2);
  assert.equal(updates.at(-1)?.status, "error");
  assert.equal(updates.at(-1)?.collected, 1);
  assert.equal(updates.at(-1)?.duplicates, 0);
});

test("all network sources failing cannot be reported as a successful zero-article run", async () => {
  process.env.DATABASE_URL ??= "postgres://localhost/test";
  const { runCrawlJob } = await import("./crawlOrchestrator");
  const updates: Record<string, unknown>[] = [];
  const fakeDb = {
    select: () => ({from: async () => []}),
    update: () => ({set: (value: Record<string, unknown>) => {updates.push(value); return {where: async () => undefined};}}),
  };
  const fail = async () => { throw new Error("unavailable"); };
  await runCrawlJob("test", "2026-09-11", "2026-09-11", { db: fakeDb as never,
    crawlNaverNews: fail, crawlNaverWebSearch: fail, crawlDaumNews: fail, crawlAllSources: fail });
  assert.equal(updates.at(-1)?.status, "error");
  assert.match(String(updates.at(-1)?.error), /수집 요청 실패/);
});

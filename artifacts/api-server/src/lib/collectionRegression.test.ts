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
    const articles = await crawlSource({name:"시험 언론사", method:"rss_direct", url:"https://example.com/rss", domain:"example.com"}, "2026-01-01", "2026-01-01", {loadFeed: () => new Parser().parseURL("fixture")});
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

test("Google and direct RSS retain ambiguous candidates for original-body review", async () => {
  const previousParse = Parser.prototype.parseURL;
  Parser.prototype.parseURL = (async () => ({ items: [
    ...COLLECTION_KEYWORDS.map((keyword, index) => ({title:`${keyword} 행사`, link:`https://example.com/${index}`, pubDate:"2026-01-10T03:00:00Z"})),
    {title:"노들길 통제와 노들로 교통", link:"https://example.com/road", pubDate:"2026-01-10T03:00:00Z"},
  ] })) as typeof Parser.prototype.parseURL;
  try {
    for (const method of ["google_news_rss", "rss_direct"] as const) {
      const articles = await crawlSource({name:"시험 언론사", method, url:"https://example.com/rss", domain:"example.com"}, "2026-01-01", "2026-01-31", {loadFeed: () => new Parser().parseURL("fixture")});
      assert.equal(articles.filter(article => !article.url.endsWith("/road")).length, COLLECTION_KEYWORDS.length);
      assert.ok(articles.every(article => article.source === method));
      assert.ok(articles.some(article => article.url.endsWith("/road")), "ambiguous candidates are reviewed, not discarded before reading originals");
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
    assert.equal(articles.filter(article => !article.url.endsWith("/road")).length, COLLECTION_KEYWORDS.length);
  } finally {
    axios.get = previousGet;
    if (previousId === undefined) delete process.env.NAVER_CLIENT_ID; else process.env.NAVER_CLIENT_ID = previousId;
    if (previousSecret === undefined) delete process.env.NAVER_CLIENT_SECRET; else process.env.NAVER_CLIENT_SECRET = previousSecret;
  }
});

test("portal pagination can accept a later relevant snippet for a previously rejected URL", async () => {
  const previousGet = axios.get;
  const pageCalls = { daum: 0, naver: 0 };
  axios.get = (async (url: string, config: {params: {q?: string; query?: string; p?: number; start?: number}}) => {
    if ((config.params.q ?? config.params.query) !== COLLECTION_KEYWORDS[0]) {
      return { data: "검색결과가 없습니다" };
    }
    const daum = url.includes("daum.net");
    pageCalls[daum ? "daum" : "naver"]++;
    const page = daum ? config.params.p : config.params.start;
    const snippet = page === 1 ? "노들길 교통 안내" : "노들섬 행사 안내";
    return { data: daum
      ? `<li><div class="item-bundle-mid"><div class="item-title"><strong><a href="https://v.daum.net/v/20260110120000123">행사 안내</a></strong></div><div class="item-contents"><span class="conts-desc">${snippet}</span></div></div></li>`
      : `<div><span class="sds-comps-profile-info-subtext">2026.01.10.</span><a data-heatmap-target=".tit" href="https://example.com/news">행사 안내</a><a data-heatmap-target=".body" href="https://example.com/news">${snippet}</a></div>` };
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
    const mockGet = t.mock.method(axios, "get", async (_url: string, config: {params: {q: string; p: number}}) => {
      if (config.params.q !== COLLECTION_KEYWORDS[0]) return { data: "검색결과가 없습니다" };
      calls++;
      return {data: config.params.p === 1 ? old + other : config.params.p === 2 ? next : old};
    });
    const articles = await crawlDaumNews("2026-04-01", "2026-04-30");
    assert.equal(articles.length, expectedCount);
    assert.equal(calls, expectedCalls);
    mockGet.mock.restore();
  }
});

test("Daum splits capped short and leap months into nonoverlapping dates and merges parent results", async t => {
  const previousTimeout = globalThis.setTimeout;
  t.mock.method(globalThis, "setTimeout", (callback: () => void) => previousTimeout(callback, 0));
  const item = (day: string, id: string) => `<li><div><div class="item-title"><a href="https://v.daum.net/v/${day}1200${id}">노들섬 행사 ${id}</a></div></div></li>`;
  for (const [start, end, expectedHalves] of [
    ["2026-02-01", "2026-02-28", [["20260201", "20260214"], ["20260215", "20260228"]]],
    ["2024-02-01", "2024-02-29", [["20240201", "20240215"], ["20240216", "20240229"]]],
    ["2024-02-28", "2024-02-29", [["20240228", "20240228"], ["20240229", "20240229"]]],
  ] as const) {
    const parentStart = start.replace(/-/g, ""), parentEnd = end.replace(/-/g, "");
    const requests: Array<{sd: string; ed: string; page: number}> = [];
    const warnings: string[] = [];
    const mockGet = t.mock.method(axios, "get", async (_url: string, config: {params: {q: string; sd: string; ed: string; p: number}}) => {
      const {q, sd, ed, p: page} = config.params;
      if (q !== COLLECTION_KEYWORDS[0]) return {data:"검색결과가 없습니다"};
      assert.ok(sd.endsWith("000000")); assert.ok(ed.endsWith("235959"));
      requests.push({sd:sd.slice(0,8), ed:ed.slice(0,8), page});
      if (sd.slice(0,8) === parentStart && ed.slice(0,8) === parentEnd) {
        return {data:Array.from({length:10}, (_, index) => item(parentEnd, String(page * 10 + index))).join("")};
      }
      if (page > 1) return {data:"검색결과가 없습니다"};
      const duplicateParent = ed.slice(0,8) === parentEnd ? item(parentEnd, "10") : "";
      return {data:duplicateParent + item(sd.slice(0,8), "999")};
    });
    const articles = await crawlWarnings.run(warnings, () => crawlDaumNews(start, end));
    assert.deepEqual(requests.filter(request => request.page === 1).map(({sd, ed}) => [sd, ed]), [[parentStart,parentEnd], ...expectedHalves]);
    assert.equal(requests.length, 24);
    assert.equal(articles.length, 202);
    assert.equal(new Set(articles.map(article => article.url)).size, 202);
    assert.ok(articles.some(article => article.url.endsWith(`${parentEnd}120010`)));
    assert.equal(warnings.length, 0);
    mockGet.mock.restore();
  }
});

test("Daum can recursively split a capped child and preserves parent articles when a child fails", async t => {
  const previousTimeout = globalThis.setTimeout;
  t.mock.method(globalThis, "setTimeout", (callback: () => void) => previousTimeout(callback, 0));
  const firstPages: string[] = [];
  const warnings: string[] = [];
  t.mock.method(axios, "get", async (_url: string, config: {params: {q: string; sd: string; ed: string; p: number}}) => {
    const {q, sd, ed, p: page} = config.params;
    if (q !== COLLECTION_KEYWORDS[0]) return {data:"검색결과가 없습니다"};
    const start = sd.slice(0,8), end = ed.slice(0,8);
    if (page === 1) firstPages.push(`${start}~${end}`);
    if (start === "20240227" && end === "20240227") {
      const error = Object.assign(new Error("test child unavailable"), {response:{status:403}});
      throw error;
    }
    if (start === end && page > 1) return {data:"검색결과가 없습니다"};
    const count = start === end ? 1 : 10;
    return {data:Array.from({length:count}, (_, index) => `<li><div><div class="item-title"><a href="https://v.daum.net/v/${end}1200${start}${page * 10 + index}">노들섬 행사 ${start}-${page}-${index}</a></div></div></li>`).join("")};
  });
  const articles = await crawlWarnings.run(warnings, () => crawlDaumNews("2024-02-27", "2024-02-29"));
  assert.deepEqual(firstPages, ["20240227~20240229", "20240227~20240228", "20240227~20240227", "20240228~20240228", "20240229~20240229"]);
  assert.equal(articles.length, 402);
  assert.ok(warnings.some(warning => warning.includes("test child unavailable")));
  assert.ok(warnings.every(warning => !warning.includes("탐색 한도")));
});

test("Naver follows observed JSON continuation pages for all four keywords and exact day bounds", async t => {
  const previousTimeout = globalThis.setTimeout;
  t.mock.method(globalThis, "setTimeout", (callback: () => void) => previousTimeout(callback, 0));
  const calls: Array<{query: string; start: number}> = [];
  const nextUrl = (query: string, start: number) => {
    const url = new URL("https://s.search.naver.com/p/newssearch/4/api/tab/more");
    for (const [key, value] of Object.entries({query, ds:"2026.01.10", de:"2026.01.10", pd:"3", start:String(start), ssc:"tab.news.all", nso:"so:dd,p:from20260110to20260110,a:all"})) url.searchParams.set(key, value);
    return url.toString();
  };
  t.mock.method(axios, "get", async (url: string, config: {params?: {query: string; ds: string; de: string; start: number}}) => {
    const request = new URL(url);
    const query = config.params?.query ?? request.searchParams.get("query")!;
    const start = config.params?.start ?? Number(request.searchParams.get("start"));
    assert.equal(config.params?.ds ?? request.searchParams.get("ds"), "2026.01.10");
    assert.equal(config.params?.de ?? request.searchParams.get("de"), "2026.01.10");
    if (start > 1) {
      assert.equal(config.params, undefined);
      assert.equal(url, nextUrl(query, start));
    }
    calls.push({query, start});
    const articleUrl = `https://example.com/${COLLECTION_KEYWORDS.indexOf(query as typeof COLLECTION_KEYWORDS[number])}/${start}`;
    const html = `<div><span class="sds-comps-profile-info-subtext">2026.01.10.</span><a data-heatmap-target=".tit" href="${articleUrl}">${query} 행사 ${start}</a></div>`;
    if (start === 1) {
      const encoded = JSON.stringify(nextUrl(query, 11)).replace(/\//g, "\\/").replace(/&/g, "\\u0026");
      return {data: html + `<script>var xload = new XLoad({"url":${encoded},"insertTarget":"._infinite_list"});</script>`};
    }
    return {data: JSON.stringify({collection:[{html, script:'<a data-heatmap-target=".tit" href="https://example.com/metadata">노들섬 메타데이터</a>'}], url:start === 11 ? nextUrl(query, 21) : ""})};
  });
  const articles = await crawlNaverWebSearch("2026-01-10", "2026-01-10");
  assert.equal(articles.length, COLLECTION_KEYWORDS.length * 3);
  assert.deepEqual(calls, COLLECTION_KEYWORDS.flatMap(query => [1,11,21].map(start => ({query,start}))));
  assert.ok(articles.every(article => article.publishedAt.toISOString() === "2026-01-10T03:00:00.000Z"));
  assert.ok(articles.every(article => article.url !== "https://example.com/metadata"));
});

test("Naver stops repeated continuation URLs or result pages and rejects changed hosts or dates", async t => {
  const previousTimeout = globalThis.setTimeout;
  t.mock.method(globalThis, "setTimeout", (callback: () => void) => previousTimeout(callback, 0));
  const next = "https://s.search.naver.com/p/newssearch/4/api/tab/more?query=" + encodeURIComponent(COLLECTION_KEYWORDS[0]) + "&ds=2026.01.10&de=2026.01.10&pd=3&start=11";
  const first = '<div><span class="sds-comps-profile-info-subtext">2026.01.10.</span><a data-heatmap-target=".tit" href="https://example.com/first">노들섬 첫 기사</a></div>';
  const second = '<div><span class="sds-comps-profile-info-subtext">2026.01.10.</span><a data-heatmap-target=".tit" href="https://example.com/second">노들섬 두 번째 기사</a></div>';
  for (const mode of ["url", "response", "host", "date"] as const) {
    let requests = 0;
    const mockGet = t.mock.method(axios, "get", async (url: string, config: {params?: {query: string}}) => {
      if (config.params && config.params.query !== COLLECTION_KEYWORDS[0]) return {data:"검색결과가 없습니다"};
      requests++;
      if (config.params) {
        const candidate = mode === "host" ? next.replace("s.search.naver.com", "example.com") : mode === "date" ? next.replace("de=2026.01.10", "de=2026.02.10") : next;
        // JSON responses also occur on the continuation route; validate before following them.
        return {data:JSON.stringify({collection:[{html:first}],url:candidate})};
      }
      assert.equal(url, next);
      return {data:JSON.stringify({collection:[{html:mode === "response" ? first : second}],url:mode === "response" ? next.replace("start=11", "start=21") : next})};
    });
    const warnings: string[] = [];
    await crawlWarnings.run(warnings, () => crawlNaverWebSearch("2026-01-10", "2026-01-10"));
    assert.equal(requests, mode === "host" || mode === "date" ? 1 : 2);
    assert.ok(warnings.some(warning => mode === "url" ? warning.includes("동일 다음 페이지 주소") : mode === "response" ? warning.includes("동일 페이지 반복") : warning.includes("다음 페이지 주소 형식 변경")));
    mockGet.mock.restore();
  }
});

test("full final portal pages record pagination coverage limits", async t => {
  const previousTimeout = globalThis.setTimeout;
  t.mock.method(globalThis, "setTimeout", (callback: () => void) => previousTimeout(callback, 0));
  const pageCalls = {daum: 0, naver: 0};
  t.mock.method(axios, "get", async (url: string, config: {params?: {q?: string; query?: string; p?: number; start?: number}}) => {
    if ((config.params?.q ?? config.params?.query ?? new URL(url).searchParams.get("query")) !== COLLECTION_KEYWORDS[0]) return {data: "검색결과가 없습니다"};
    const daum = url.includes("daum.net");
    pageCalls[daum ? "daum" : "naver"]++;
    const page = daum ? config.params!.p! : config.params?.start ?? Number(new URL(url).searchParams.get("start"));
    const html = Array.from({length: 10}, (_, index) => daum
      ? `<li><div><div class="item-title"><a href="https://v.daum.net/v/202601101200${page * 10 + index}">노들섬 행사 ${page}-${index}</a></div></div></li>`
      : `<div><span class="sds-comps-profile-info-subtext">2026.01.10.</span><a data-heatmap-target=".tit" href="https://example.com/${page}/${index}">노들섬 행사 ${page}-${index}</a></div>`).join("");
    const next = `https://s.search.naver.com/p/newssearch/4/api/tab/more?query=${encodeURIComponent(COLLECTION_KEYWORDS[0])}&ds=2026.01.01&de=2026.01.31&pd=3&start=${page + 10}`;
    return {data:daum ? html : JSON.stringify({collection:[{html}],url:next})};
  });
  const warnings: string[] = [];
  await crawlWarnings.run(warnings, async () => {
    assert.equal((await crawlDaumNews("2026-01-10", "2026-01-10")).length, 200);
    assert.equal((await crawlNaverWebSearch("2026-01-01", "2026-01-31")).length, 1000);
  });
  assert.deepEqual(pageCalls, {daum: 20, naver: 100});
  assert.ok(warnings.some(warning => /다음.*하루 범위에서도 20페이지 탐색 한도/.test(warning)));
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

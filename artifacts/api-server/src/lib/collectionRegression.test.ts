import test from "node:test";
import assert from "node:assert/strict";
import axios from "axios";
import { googleFeedUrl, kstDate, mapConcurrent, validateDateRange } from "./crawlRuntime";
import { crawlNaverNews, parseNaverDateText } from "./crawlerSources";

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

test("Google query includes the requested historical interval and press filter", () => {
  const url = new URL(googleFeedUrl("https://news.google.com/rss/search?q=노들+site:example.com&hl=ko", "2026-01-01", "2026-01-31"));
  assert.equal(url.searchParams.get("q"), "노들 site:example.com after:2025-12-31 before:2026-02-01");
  assert.equal(url.searchParams.get("hl"), "ko");
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

test("multi-month Naver request fetches the API once, without pretending dates bypass its cap", async () => {
  const previousGet = axios.get;
  const previousId = process.env.NAVER_CLIENT_ID;
  const previousSecret = process.env.NAVER_CLIENT_SECRET;
  process.env.NAVER_CLIENT_ID = "test";
  process.env.NAVER_CLIENT_SECRET = "test";
  let calls = 0;
  axios.get = (async (_url: string, config: {params: {start: number}}) => {
    calls++;
    assert.equal(config.params.start, 1);
    return { data: { items: [{ title:"노들섬 행사", description:"노들섬", originallink:"https://example.com/news", pubDate:"2026-08-01T03:00:00Z" }] } };
  }) as typeof axios.get;
  try {
    const articles = await crawlNaverNews("2026-01-01", "2026-09-11");
    assert.equal(calls, 1);
    assert.equal(articles.length, 1);
  } finally {
    axios.get = previousGet;
    if (previousId === undefined) delete process.env.NAVER_CLIENT_ID; else process.env.NAVER_CLIENT_ID = previousId;
    if (previousSecret === undefined) delete process.env.NAVER_CLIENT_SECRET; else process.env.NAVER_CLIENT_SECRET = previousSecret;
  }
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

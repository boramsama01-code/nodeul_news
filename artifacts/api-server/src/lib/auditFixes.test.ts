import test from "node:test";
import assert from "node:assert/strict";
import axios from "axios";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DATABASE_URL ||= "postgres://audit:audit@127.0.0.1:1/audit";

const instant = (t: { mock: { method: (o: object, m: string, f: unknown) => void } }) => {
  const original = globalThis.setTimeout;
  t.mock.method(globalThis, "setTimeout", (cb: () => void) => original(cb, 0));
};

test("C-01 job status: blocked routes make a run partial, never done", async () => {
  const { decideJobStatus } = await import("./crawlRuntime");
  const blocked = ["네이버 웹: 응답에서 사람 확인(CAPTCHA) 신호 감지 — 앱 요청 휴식 중"];
  const info = ["[참고] 경향신문: 직접 피드의 보관 범위 밖 또는 피드 미지원: 구글뉴스 검색으로 기간을 보완합니다."];
  assert.equal(decideJobStatus({ insertFailures: 0, candidates: 12, warnings: blocked }), "partial");
  assert.equal(decideJobStatus({ insertFailures: 0, candidates: 0, warnings: blocked }), "error");
  assert.equal(decideJobStatus({ insertFailures: 0, candidates: 12, warnings: info }), "done");
  assert.equal(decideJobStatus({ insertFailures: 1, candidates: 12, warnings: [] }), "error");
});

test("C-01 bulk month with all portals blocked is stored as partial", async () => {
  const { runBulkCrawlJob } = await import("./bulkCrawlOrchestrator");
  const { warnSource } = await import("./crawlRuntime");
  const updates: Record<string, unknown>[] = [];
  const fakeDb = {
    select: () => ({ from: async () => [] }),
    update: () => ({ set: (v: Record<string, unknown>) => { updates.push(v); return { where: async () => undefined }; } }),
    insert: () => ({ values: async () => undefined }),
  };
  const one = { title: "노들섬 행사", content: "노들섬", url: "https://www.mk.co.kr/news/culture/1", publishedAt: new Date("2026-10-10T03:00:00Z"), mediaName: "매일경제", isNegative: false, isSelfPR: false, source: "publisher_search" };
  await runBulkCrawlJob("bulk-fix", "2026-10-01", "2026-10-22", {
    db: fakeDb as never, analyzeArticleSentiment: async () => false,
    crawlNaverWebSearch: async () => { warnSource("네이버 웹", "CAPTCHA — 앱 요청 휴식 중"); return []; },
    crawlDaumNews: async () => { warnSource("다음", "CAPTCHA — 앱 요청 휴식 중"); return []; },
    crawlAllSources: async () => [one],
  });
  assert.equal(updates.at(-1)?.status, "partial");
});

test("C-09 Naver keeps the received page when the next-page address names another period", async (t) => {
  instant(t);
  const dir = await mkdtemp(join(tmpdir(), "audit-c09-"));
  const previous = process.env.DATA_DIR; process.env.DATA_DIR = dir;
  try {
    const { crawlNaverWebSearch } = await import("./crawlerSources");
    const { crawlWarnings } = await import("./crawlRuntime");
    const next = "https://s.search.naver.com/p/newssearch/3/api/tab/more?query=%EB%85%B8%EB%93%A4%EC%84%AC&nso=so%3Add%2Cp%3Afrom20240101to20240114&start=11";
    const page1 = `<div><span class="sds-comps-profile-info-subtext">2025.01.12.</span><a data-heatmap-target=".tit" href="https://www.yna.co.kr/view/AKR1">노들섬 전시 기사</a></div><script>var x = new XLoad({"url":${JSON.stringify(next)}});</script>`;
    t.mock.method(axios, "get", async (_url: string, cfg: { params?: { query?: string } }) =>
      cfg.params?.query === "노들섬" ? { status: 200, data: page1 } : { status: 200, data: "검색결과가 없습니다" });
    const warnings: string[] = [];
    const rows = await crawlWarnings.run(warnings, () => crawlNaverWebSearch("2025-01-01", "2025-01-14"));
    assert.deepEqual(rows.map((row) => row.url), ["https://www.yna.co.kr/view/AKR1"]);
    assert.ok(warnings.some((w) => w.includes("다음 페이지 주소 형식 변경")));
    assert.ok(!warnings.some((w) => w.includes("네트워크 연결 또는 응답 시간 초과")));
  } finally {
    if (previous === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = previous;
    await rm(dir, { recursive: true, force: true });
  }
});

test("C-09 Naver continuation rules: nso period accepted only when it equals the requested range", async () => {
  const { naverContinuationMatches } = await import("./crawlerSources");
  const base = "https://s.search.naver.com/p/newssearch/3/api/tab/more?query=%EB%85%B8%EB%93%A4%EC%84%AC";
  const ok = (suffix: string) => naverContinuationMatches(new URL(base + suffix), "노들섬", "2025.01.01", "2025.01.14");
  assert.equal(ok("&nso=so%3Add%2Cp%3Afrom20250101to20250114&start=11"), true, "nso-only period");
  assert.equal(ok("&pd=3&ds=2025.01.01&de=2025.01.14&start=11"), true, "ds/de period");
  assert.equal(ok("&pd=3&ds=2025.01.01&de=2025.01.14&nso=so%3Add%2Cp%3Afrom20250101to20250114"), true, "both, agreeing");
  assert.equal(ok("&nso=so%3Add%2Cp%3Afrom20240101to20240114"), false, "another period");
  assert.equal(ok("&nso=so%3Add%2Cp%3Aall"), false, "all periods");
  assert.equal(ok("&pd=3&ds=2025.01.01&de=2025.01.14&nso=so%3Add%2Cp%3Afrom20240101to20240114"), false, "conflicting periods");
  assert.equal(ok("&pd=1&nso=so%3Add%2Cp%3Afrom20250101to20250114"), false, "preset period code");
  assert.equal(ok("&start=11"), false, "no period at all");
  assert.equal(naverContinuationMatches(new URL("https://s.search.naver.com/p/newssearch/3/api/tab/more?query=other&nso=p%3Afrom20250101to20250114"), "노들섬", "2025.01.01", "2025.01.14"), false, "other query");
  assert.equal(naverContinuationMatches(new URL("https://evil.example/p/newssearch/3/api/tab/more?query=%EB%85%B8%EB%93%A4%EC%84%AC&nso=p%3Afrom20250101to20250114"), "노들섬", "2025.01.01", "2025.01.14"), false, "other host");
});

test("C-20 boolean filters keep false as false and page size is capped", async () => {
  const { normalizeListQuery, clampPageSize } = await import("./queryParams");
  const { ListArticlesQueryParams } = await import("@workspace/api-zod");
  assert.equal(ListArticlesQueryParams.parse(normalizeListQuery({ isNegative: "false" })).isNegative, false);
  assert.equal(ListArticlesQueryParams.parse(normalizeListQuery({ isNegative: "true" })).isNegative, true);
  assert.equal(ListArticlesQueryParams.parse(normalizeListQuery({})).isNegative, undefined);
  assert.equal(clampPageSize(20000), 200);
  assert.equal(clampPageSize(0), 1);
});

test("C-08 an article trashed under one route is not re-added by another route", async () => {
  const { loadExistingArticles } = await import("./existingArticles");
  const url = "https://www.yna.co.kr/view/AKR1";
  const rows = [{ id: 1, url, title: "노들섬", publishedAt: new Date(), source: "naver_api", mediaName: "연합뉴스", deletedAt: new Date(), content: "노들섬" }];
  const existing = await loadExistingArticles({ select: () => ({ from: async () => rows }) } as never);
  const again = { title: "노들섬", content: "노들섬", url, publishedAt: new Date(), mediaName: "네이버(연합뉴스)", isNegative: false, isSelfPR: false, source: "naver_web" };
  assert.equal(await existing.duplicate(again), true);
  assert.match(existing.summary(), /휴지통 중복 제외 1건/);
});

test("C-03 write rate limit answers 429 after the window budget and runs before API routes", async () => {
  const { rateLimit } = await import("./requestLimits");
  let at = 0; const limiter = rateLimit({ windowMs: 60_000, max: 2, methods: ["POST"], now: () => at });
  const statuses: number[] = [];
  for (let i = 0; i < 3; i++) {
    const res = { statusCode: 200, setHeader() {}, status(code: number) { this.statusCode = code; return this; }, json() { return this; } };
    let passed = false;
    limiter({ method: "POST", ip: "203.0.113.9" } as never, res as never, () => { passed = true; });
    statuses.push(passed ? 200 : res.statusCode);
  }
  assert.deepEqual(statuses, [200, 200, 429]);
  at = 60_000;
  let passed = false;
  limiter({ method: "POST", ip: "203.0.113.9" } as never, { setHeader() {}, status() { return this; }, json() { return this; } } as never, () => { passed = true; });
  assert.equal(passed, true);
  const { readFile } = await import("node:fs/promises");
  const appSource = await readFile(new URL("../app.ts", import.meta.url), "utf8");
  assert.ok(appSource.indexOf("limitWrites()") < appSource.indexOf('app.use("/api", router)'), "all write requests spend the budget before reaching routes");
});

test("C-03 crawl span limits", async () => {
  const { validateCrawlSpan } = await import("./crawlRuntime");
  validateCrawlSpan("2026-01-01", "2026-01-31", 31);
  assert.throws(() => validateCrawlSpan("2026-01-01", "2026-02-01", 31), /최대 31일/);
  assert.throws(() => validateCrawlSpan("1900-01-01", "1900-01-02", 31), /2015-01-01/);
});

test("C-10 host-name and search-label publishers become backfill targets with their portal prefix kept", async () => {
  const { formatResolvedMediaName } = await import("./publisherBackfill");
  assert.equal(formatResolvedMediaName("네이버(sports.khan.co.kr)", "스포츠경향"), "네이버(스포츠경향)");
  assert.equal(formatResolvedMediaName("구글뉴스-노들(최신)", "뉴시스"), "구글뉴스(뉴시스)");
  assert.equal(formatResolvedMediaName("asiatoday.co.kr", "아시아투데이"), "아시아투데이");
});

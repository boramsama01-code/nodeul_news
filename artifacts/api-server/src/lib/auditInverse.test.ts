// Inverse of the audit reproductions R1-R11: each test runs the scenario that
// reproduced a defect on main and asserts the corrected behaviour.
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

async function withDataDir<T>(prefix: string, run: () => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  const previous = process.env.DATA_DIR; process.env.DATA_DIR = dir;
  try { return await run(); }
  finally {
    if (previous === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = previous;
    await rm(dir, { recursive: true, force: true });
  }
}

test("R1 Naver: a next-page address that carries the same period in `nso` is followed", async (t) => {
  instant(t);
  await withDataDir("inv-r1-", async () => {
    const { crawlNaverWebSearch } = await import("./crawlerSources");
    const { crawlWarnings } = await import("./crawlRuntime");
    const next = "https://s.search.naver.com/p/newssearch/3/api/tab/more?query=%EB%85%B8%EB%93%A4%EC%84%AC&nso=so%3Add%2Cp%3Afrom20250101to20250114&start=11";
    const page1 = `<div><span class="sds-comps-profile-info-subtext">2025.01.12.</span><a data-heatmap-target=".tit" href="https://www.yna.co.kr/view/AKR1">노들섬 전시 기사</a></div>`
      + `<script>var x = new XLoad({"url":${JSON.stringify(next)}});</script>`;
    const page2 = { collection: [{ html: `<div><span class="sds-comps-profile-info-subtext">2025.01.03.</span><a data-heatmap-target=".tit" href="https://www.yna.co.kr/view/AKR2">노들섬 공연 기사</a></div>` }], url: "" };
    const requested: string[] = [];
    t.mock.method(axios, "get", async (url: string, cfg: { params?: { query?: string } }) => {
      requested.push(url);
      if (url.startsWith("https://s.search.naver.com/")) return { status: 200, data: page2 };
      return cfg.params?.query === "노들섬" ? { status: 200, data: page1 } : { status: 200, data: "검색결과가 없습니다" };
    });
    const warnings: string[] = [];
    const rows = await crawlWarnings.run(warnings, () => crawlNaverWebSearch("2025-01-01", "2025-01-14"));
    assert.deepEqual(rows.map((row) => row.url).sort(), ["https://www.yna.co.kr/view/AKR1", "https://www.yna.co.kr/view/AKR2"]);
    assert.ok(requested.includes(next), "the continuation was requested");
    assert.deepEqual(warnings, []);
  });
});

test("R2 bulk job with Naver, Daum and Google blocked ends partial, not done", async () => {
  const { runBulkCrawlJob } = await import("./bulkCrawlOrchestrator");
  const { warnSource } = await import("./crawlRuntime");
  const updates: Record<string, unknown>[] = [];
  const fakeDb = {
    select: () => ({ from: async () => [] }),
    update: () => ({ set: (v: Record<string, unknown>) => { updates.push(v); return { where: async () => undefined }; } }),
    insert: () => ({ values: async () => undefined }),
  };
  const one = { title: "노들섬 행사", content: "노들섬", url: "https://www.mk.co.kr/news/culture/1", publishedAt: new Date("2026-10-10T03:00:00Z"), mediaName: "매일경제", isNegative: false, isSelfPR: false, source: "publisher_search" };
  await runBulkCrawlJob("bulk-inverse", "2026-10-01", "2026-10-22", {
    db: fakeDb as never, analyzeArticleSentiment: async () => false,
    crawlNaverWebSearch: async () => { warnSource("네이버 웹", "응답에서 사람 확인(CAPTCHA) 신호 감지 — 앱 요청 휴식 중"); return []; },
    crawlDaumNews: async () => { warnSource("다음", "CAPTCHA — 앱 요청 휴식 중"); return []; },
    crawlAllSources: async () => { warnSource("구글뉴스 RSS", "HTTP 503 — 남은 구글뉴스 검색 생략"); return [one]; },
  });
  assert.equal(updates.at(-1)!.status, "partial");
  assert.match(String(updates.at(-1)!.error), /CAPTCHA/);
});

test("R3 a failing chunk keeps the earlier chunks and is reported as incomplete", async (t) => {
  instant(t);
  const { crawlDateChunks } = await import("./crawlPacing");
  const { crawlWarnings, incompleteWarnings, decideJobStatus } = await import("./crawlRuntime");
  let calls = 0;
  const warnings: string[] = [];
  const rows = await crawlWarnings.run(warnings, () => crawlDateChunks("audit", async (start) => {
    calls++; if (calls === 3) throw new Error("pool ended"); return [start];
  }, "2026-01-01", "2026-01-31"));
  assert.equal(calls, 5, "the remaining chunks still run");
  assert.deepEqual(rows, ["2026-01-01", "2026-01-08", "2026-01-22", "2026-01-29"]);
  assert.equal(incompleteWarnings(warnings).length, 1);
  assert.match(warnings[0], /2026-01-15~2026-01-21 구간 수집 실패/);
  assert.equal(decideJobStatus({ insertFailures: 0, candidates: rows.length, warnings }), "partial");
});

test("R4 source health uses the loader's support level and groups section feeds per publisher", async () => {
  const { loadOfficialFeed } = await import("./sourceFeeds");
  const { summarizeSourceHealth } = await import("./rssHealthAudit");
  const sitemap = `<?xml version="1.0"?><urlset xmlns:news="http://www.google.com/schemas/sitemap-news/0.9"><url><loc>https://www.example-paper.kr/a/1</loc><news:news><news:publication_date>2026-10-22T10:00:00+09:00</news:publication_date><news:title>최근 기사</news:title></news:news></url></urlset>`;
  const loaded = await loadOfficialFeed({ name: "예시", method: "rss_direct", url: "https://www.example-paper.kr/sitemap/latest.xml", domain: "example-paper.kr" },
    { fetch: async (url) => ({ status: 200, body: sitemap, url }) });
  const item = (name: string, url: string, support: "normal" | "partial" | "unsupported" | undefined, itemCount: number, status: "ok" | "empty" | "error") =>
    ({ name, url, support, itemCount, status, reason: support === "partial" ? "advertised_news_sitemap" : undefined, newest: itemCount ? "2026-10-22T01:00:00.000Z" : undefined, oldest: itemCount ? "2026-10-15T01:00:00.000Z" : undefined });
  const report = summarizeSourceHealth([
    item("예시", "https://www.example-paper.kr/sitemap/latest.xml", loaded.status, loaded.feed.items.length, "ok"),
    ...["Pol", "Eco", "Soc"].map((s) => item("국민일보", `https://www.kmib.co.kr/rss/data/kmib${s}Rss.xml`, "normal", 20, "ok")),
    item("빈피드", "https://empty.example/rss.xml", "unsupported", 0, "error"),
    item("이전점검", "https://legacy.example/rss.xml", undefined, 12, "ok"),
  ]);
  const by = Object.fromEntries(report.sources.map((s) => [s.name, s]));
  assert.equal(loaded.status, "partial");
  assert.equal(by["예시"].status, "partial", "a news sitemap is shown as partial, not 정상");
  assert.equal(by["국민일보"].status, "normal");
  assert.equal(by["국민일보"].scope, "section");
  assert.equal(by["국민일보"].feedCount, 3);
  assert.equal(by["빈피드"].status, "unsupported");
  assert.equal(by["이전점검"].status, "partial", "a report without a support level is never shown as normal");
  assert.deepEqual({ publishers: report.summary.publishers, feeds: report.summary.feeds }, { publishers: 4, feeds: 6 });
});

test("R5 an article trashed under one route is not re-added by another route, also with URL variants", async () => {
  const { loadExistingArticles } = await import("./existingArticles");
  const rows = [{ id: 1, url: "https://www.yna.co.kr/view/AKR1", title: "노들섬", publishedAt: new Date(), source: "naver_api", mediaName: "연합뉴스", deletedAt: new Date(), content: "노들섬" }];
  const existing = await loadExistingArticles({ select: () => ({ from: async () => rows }) } as never);
  const again = (url: string) => ({ title: "노들섬", content: "노들섬", url, publishedAt: new Date(), mediaName: "네이버(연합뉴스)", isNegative: false, isSelfPR: false, source: "naver_web" });
  assert.equal(await existing.duplicate(again("https://www.yna.co.kr/view/AKR1")), true);
  assert.equal(await existing.duplicate(again("http://yna.co.kr/view/AKR1/?utm_source=naver#top")), true);
  assert.equal(await existing.duplicate(again("https://www.yna.co.kr/view/AKR2")), false, "a different article is still collected");
});

test("R6 the article's own publisher outranks a WebSite-level group name and is not learned as a host alias", async () => {
  const { inspectPublisherPage, createPublisherResolver } = await import("./publisherResolver");
  const html = `<html><head>
    <script type="application/ld+json">{"@type":"WebSite","name":"x","publisher":{"@type":"Organization","name":"OO미디어그룹"}}</script>
    <script type="application/ld+json">{"@type":"NewsArticle","headline":"h","publisher":{"@type":"Organization","name":"OO일보"}}</script>
    <meta property="og:site_name" content="OO미디어그룹"></head><body></body></html>`;
  const identity = inspectPublisherPage(html, "https://news.oo-media.example/article/1");
  assert.equal(identity.publisher, "OO일보");
  assert.equal(identity.aliasEligible, false, "disagreeing signals never become a 30-day host alias");
  assert.ok(identity.evidence.includes("publisher-signals-disagree"));

  const resolver = createPublisherResolver({ cachePath: false, hostDelayMs: 0, lookup: async () => [{ address: "8.8.8.8", family: 4 }],
    transport: async () => ({ status: 200, headers: {}, body: '<script type="application/ld+json">{"@type":"NewsArticle","publisher":{"name":"OO미디어그룹"}}</script>' }) });
  const viaPortal = await resolver.resolveArticleIdentity("https://n.news.naver.com/article/001/1", "네이버(OO일보)");
  assert.equal(viaPortal.publisher, "OO일보", "the portal's press label outranks page metadata");
  assert.equal(viaPortal.status, "partial");
});

test("R8 RSS dates with a KST suffix or Korean dotted format are kept; impossible dates are rejected", async () => {
  const { parseRssPublishedAt } = await import("./crawlRuntime");
  assert.equal(parseRssPublishedAt({ pubDate: "Wed, 01 Jan 2025 10:00:00 KST" })?.toISOString(), "2025-01-01T01:00:00.000Z");
  assert.equal(parseRssPublishedAt({ pubDate: "2025.01.01 10:00" })?.toISOString(), "2025-01-01T01:00:00.000Z");
  assert.equal(parseRssPublishedAt({ pubDate: "2025.1.2" })?.toISOString(), "2025-01-01T15:00:00.000Z");
  assert.equal(parseRssPublishedAt({ pubDate: "Wed, 01 Jan 2025 10:00:00 +0900" })?.toISOString(), "2025-01-01T01:00:00.000Z");
  assert.equal(parseRssPublishedAt({ pubDate: "2025.02.30 10:00" }), null);
  assert.equal(parseRssPublishedAt({ pubDate: "Sun, 31 Feb 2025 10:00:00 +0900" }), null);
});

test("R9 settings work without a password and still persist encrypted API keys", async () => {
  const { pool } = await import("@workspace/db");
  const original = pool.query;
  const previousBackend = process.env.STATE_BACKEND;
  process.env.STATE_BACKEND = "postgres";
  process.env.CONFIG_ENCRYPTION_KEY = "audit-fixture-key-audit-fixture-key-0000";
  const saved = new Map<string, unknown>();
  pool.query = (async (sql: string, params: unknown[]) => {
    if (sql.startsWith("INSERT INTO app_state")) saved.set(String(params[0]), params[1]);
    return { rows: [] };
  }) as typeof pool.query;
  try {
    const { default: app } = await import("../app");
    const { IncomingMessage, ServerResponse } = await import("node:http");
    const { Socket } = await import("node:net");
    const call = (method: string, url: string, body: unknown, headers: Record<string, string> = {}) =>
      new Promise<{ status: number; cookie?: string }>((resolve) => {
        const req = new IncomingMessage(new Socket());
        const text = JSON.stringify(body);
        req.method = method; req.url = url;
        req.headers = { host: "nodeul-news.onrender.com", "content-type": "application/json", "content-length": String(Buffer.byteLength(text)), ...headers };
        const res = new ServerResponse(req);
        res.end = ((() => { const cookie = res.getHeader("set-cookie"); resolve({ status: res.statusCode, cookie: cookie ? String(cookie) : undefined }); return res; }) as never);
        app(req, res);
        req.push(text); req.push(null);
      });
    const result = await call("POST", "/api/settings/naver-key", { clientId: "owner-id", clientSecret: "owner-secret" });
    assert.equal(result.status, 200);
    assert.equal(result.cookie, undefined);
    assert.equal(process.env.NAVER_CLIENT_ID, "owner-id");
    assert.equal(saved.has("runtime-config"), true);
    assert.ok(!JSON.stringify(saved.get("runtime-config")).includes("owner-secret"));
    assert.equal((await call("POST", "/api/settings/naver-key", { clientId: "", clientSecret: "" })).status, 400);
    assert.equal((await call("POST", "/api/crawl/start", { startDate: "bad", endDate: "bad" })).status, 400);
    assert.equal((await call("POST", "/api/articles/import-urls", { urls: [] })).status, 400);
    assert.equal((await call("POST", "/api/settings/naver-key", { clientId: "other", clientSecret: "other-secret" }, { origin: "https://untrusted.example" })).status, 403);
    assert.equal(process.env.NAVER_CLIENT_ID, "owner-id");
  } finally {
    pool.query = original;
    if (previousBackend === undefined) delete process.env.STATE_BACKEND; else process.env.STATE_BACKEND = previousBackend;
    delete process.env.NAVER_CLIENT_ID; delete process.env.NAVER_CLIENT_SECRET;
  }
});

test("R10 isNegative=false stays false", async () => {
  const { normalizeListQuery } = await import("./queryParams");
  const { ListArticlesQueryParams } = await import("@workspace/api-zod");
  assert.equal(ListArticlesQueryParams.parse(normalizeListQuery({ isNegative: "false" })).isNegative, false);
});

test("R11 historical audit keeps its progress when the day changes after the first start", async () => {
  const { auditEndDate, validProgress } = await import("./historicalAudit");
  const firstDay = auditEndDate({ today: "2026-10-22" });
  const stored = { version: 3, startDate: "2026-01-01", endDate: firstDay } as never;
  const nextDay = auditEndDate({ anchored: firstDay, today: "2026-10-23" });
  assert.equal(nextDay, "2026-10-22");
  assert.equal(validProgress(stored, "2026-01-01", nextDay), true);
  assert.equal(auditEndDate({ configured: "2026-09-30", anchored: firstDay, today: "2026-10-23" }), "2026-09-30");
});

test("C-07 per-publisher Google queries are sent only when the global query hits the 100-item cap", async (t) => {
  instant(t);
  await withDataDir("inv-c07-", async () => {
    const { GOOGLE_NEWS_SOURCES } = await import("./rssFeedList");
    const { crawlAllSourcesPaced } = await import("./pacedSources");
    const rss = (count: number, day: string) => `<?xml version="1.0"?><rss version="2.0"><channel><title>t</title>${Array.from({ length: count }, (_, i) =>
      `<item><title>노들섬 소식 ${i} - 연합뉴스</title><link>https://news.google.com/rss/articles/${day}-${i}</link><pubDate>${new Date(`${day}T03:00:00Z`).toUTCString()}</pubDate><description>노들섬</description></item>`).join("")}</channel></rss>`;
    let googleRequests = 0;
    let globalItems = 3;
    let day = "2025-03-03";
    t.mock.method(axios, "get", async (url: string) => {
      if (url.startsWith("https://news.google.com/")) {
        googleRequests++;
        const global = !decodeURIComponent(url).includes("site:");
        return { status: 200, data: rss(global ? globalItems : 1, day), headers: {} };
      }
      return { status: 404, data: "", headers: {} };
    });
    const previousDeep = process.env.DEEP_ARCHIVE_GOOGLE_SOURCES;
    process.env.DEEP_ARCHIVE_GOOGLE_SOURCES = "true";
    try {
      await crawlAllSourcesPaced("2025-03-03", "2025-03-05");
      assert.equal(googleRequests, 1, "global query below the cap: no per-publisher queries");
      googleRequests = 0; globalItems = 100; day = "2025-04-07";
      await crawlAllSourcesPaced("2025-04-07", "2025-04-09");
      assert.equal(googleRequests, GOOGLE_NEWS_SOURCES.length, "global query at the cap: per-publisher queries run");
    } finally {
      if (previousDeep === undefined) delete process.env.DEEP_ARCHIVE_GOOGLE_SOURCES; else process.env.DEEP_ARCHIVE_GOOGLE_SOURCES = previousDeep;
    }
  });
});

// Last: shutdown aborts the process-wide signal.
test("R7 shutdown waits for a crashed job's final status write before the pool may close", async () => {
  const { startTrackedJob, drainBackgroundTasks } = await import("./lifecycle");
  const events: string[] = [];
  void startTrackedJob("job-r7", async () => { throw new Error("crawl crashed"); }, async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
    events.push("status written");
  });
  const unfinished = await drainBackgroundTasks(2_000);
  events.push("pool may close");
  assert.deepEqual(events, ["status written", "pool may close"]);
  assert.deepEqual(unfinished, []);
});

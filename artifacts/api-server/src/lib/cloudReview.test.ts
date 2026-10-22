import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRelevanceReview, readRelevanceReviews } from "./relevanceReview";
import { createPublisherResolver } from "./publisherResolver";
import { readProviderHealth, recordProviderHealth } from "./providerHealth";

process.env.DATABASE_URL ||= "postgresql://localhost/test";

test("Render review queue, original-page cache and provider cooldown survive fresh instances without files", async () => {
  const { pool } = await import("@workspace/db");
  const query = pool.query, backend = process.env.STATE_BACKEND, dataDir = process.env.DATA_DIR;
  const directory = await mkdtemp(join(tmpdir(), "nodeul-cloud-review-"));
  process.env.STATE_BACKEND = "postgres";
  process.env.DATA_DIR = directory;
  const saved = new Map<string, unknown>();
  pool.query = (async (sql: string, params: unknown[]) => {
    const key = String(params[0]);
    if (sql.startsWith("INSERT INTO app_state")) saved.set(key, JSON.parse(String(params[1])));
    const rows = sql.includes("starts_with")
      ? [...saved].filter(([id]) => id.startsWith(key)).map(([,value]) => ({value}))
      : saved.has(key) ? [{value: saved.get(key)}] : [];
    return {rows};
  }) as typeof pool.query;
  try {
    const article = {title:"공연 소식",content:"",url:"https://unknown.example/news?source=naver",publishedAt:new Date("2026-01-15T03:00:00Z"),source:"naver_web",mediaName:"네이버(기타)",isNegative:false,isSelfPR:false};
    let now = Date.now();
    const review = await createRelevanceReview({now: () => now, resolve:async url => ({originalUrl:url,publisher:null,evidence:["HTTP 403"],status:"blocked"})});
    await review.assess(article);
    await review.assess({...article,source:"daum_web"});
    assert.equal((await readRelevanceReviews()).length, 2);
    now += 7 * 3600_000;
    const restarted = await createRelevanceReview({now: () => now, maxRequests:0});
    assert.equal(restarted.retryCandidates("2026-01-01","2026-01-31").length,2);
    await restarted.delivered(article);
    assert.equal((await createRelevanceReview({now: () => now, maxRequests:0})).retryCandidates("2026-01-01","2026-01-31").length,1);

    let requests = 0;
    const resolverOptions = {hostDelayMs:0, lookup:async () => [{address:"8.8.8.8",family:4}], transport:async () => {
      requests++;
      return {status:200,headers:{},body:`<meta property="og:site_name" content="검증일보"><article>${"노들섬 공연을 개최합니다. ".repeat(30)}</article>`};
    }};
    const first = createPublisherResolver(resolverOptions);
    await first.resolveArticleIdentity(article.url);
    await first.resolveArticleContent(article.url);
    await first.flush();
    const before = requests;
    const second = createPublisherResolver(resolverOptions);
    assert.equal((await second.resolveArticleIdentity(article.url)).publisher,"검증일보");
    assert.equal((await second.resolveArticleContent(article.url)).textComplete,true);
    assert.equal(requests,before,"a new resolver reuses persisted network results");
    await recordProviderHealth("naver_web",{status:"limited",reason:"fixture",checkedAt:new Date().toISOString(),blockedUntil:new Date(now).toISOString()});
    assert.ok(saved.has("provider-health"));
    assert.equal((await readProviderHealth()).naver_web.status,"limited");
    assert.deepEqual(await readdir(directory),[]);

    pool.query = (async () => {throw new Error("database unavailable");}) as typeof pool.query;
    await assert.rejects(readRelevanceReviews(), /database unavailable/);
    await assert.rejects(restarted.assess({...article,url:"https://unknown.example/new"}), /database unavailable/);
  } finally {
    pool.query = query;
    if (backend === undefined) delete process.env.STATE_BACKEND; else process.env.STATE_BACKEND = backend;
    if (dataDir === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = dataDir;
  }
});

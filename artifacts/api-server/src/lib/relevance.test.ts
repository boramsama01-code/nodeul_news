import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyRelevance } from "./relevance";
import { extractArticleText } from "./articleText";
import { createPublisherResolver } from "./publisherResolver";
import { createRelevanceReview, readRelevanceReviews } from "./relevanceReview";
import type { ArticleData } from "./crawlerUtils";

const candidate = (changes: Partial<ArticleData> = {}): ArticleData => ({
  title: "봄 공연 개막", content: "", url: "https://www.seoul.co.kr/news/a?from=naver#story", source: "naver_web",
  mediaName: "네이버(서울신문)", publishedAt: new Date("2026-04-03T02:00:00Z"), isNegative: false, isSelfPR: false, ...changes,
});
const transportOptions = {cachePath: false as const, hostDelayMs: 0, lookup: async () => [{address: "8.8.8.8", family: 4}]};
const articleBody = (subject: string) => `<article><p>${subject}</p><p>${"시민 참여 프로그램의 운영 계획과 이용 방법을 안내했다. ".repeat(12)}</p></article>`;

test("island aliases and contextual project name survive without a literal 노들섬", () => {
  for (const title of ["노들예술섬 설계 공개", "노들 예술 섬 개장", "글로벌노들 건축 설계", "글로벌 노들 문화공간 조성", "Nodeul Island concert"]) assert.equal(classifyRelevance(title, "").status, "related", title);
  assert.equal(classifyRelevance("글로벌노들", "서울에서 공연을 개최했다.").status, "pending");
});
test("unrelated station/road/centre terms do not override actual island content", () => {
  for (const term of ["노들역", "노들로", "노들장애인센터", "노들장애인자립생활센터", "노들장애인야학", "노들강변", "노들나루공원"]) {
    assert.equal(classifyRelevance(`${term} 소식`, `${term} 이용 안내`, true).status, "unrelated", term);
    assert.equal(classifyRelevance(`${term} 소식`, "노들섬에서 열린 문화행사에 참여했다.", true).status, "related", term);
    assert.equal(classifyRelevance(`${term} 소식`, "").status, "pending", "a headline alone cannot rule out an island event in the body");
  }
});
test("ambiguous and unavailable bodies stay pending, not false negatives", () => {
  assert.equal(classifyRelevance("봄 축제 개막", "").status, "pending");
  assert.equal(classifyRelevance("노들 시민 행사", "무엇을 가리키는지는 확인되지 않았다.", true).status, "pending");
  assert.equal(classifyRelevance("다른 지역 축제", "부산 행사 안내", true).status, "unrelated");
});
test("article extraction ignores navigation/related links and understands JSON-LD", () => {
  const parsed = extractArticleText(`<nav>노들섬 공연</nav>${articleBody("노들역 승강기 교체").replace('</article>', '<aside>노들섬</aside><div class="related">노들예술섬</div></article>')}`);
  assert.equal(parsed.complete, true);
  assert.equal(classifyRelevance("노들역 승강기 교체", parsed.text, parsed.complete).status, "unrelated");
  assert.equal(extractArticleText('<meta name="description" content="노들역">').complete, false);
  assert.match(extractArticleText('<script type="application/ld+json">'+JSON.stringify({"@type":"NewsArticle",articleBody:"노들섬에서 열린 행사"})+'</script>').text, /노들섬/);
});
test("missing snippets recover from original text, cache requests and preserve every exact route", async () => {
  let calls = 0;
  const resolver = createPublisherResolver({...transportOptions, transport: async () => { calls++; return {status:200, headers:{}, body:articleBody("노들섬에서 봄 공연을 개최한다.")}; }});
  const review = await createRelevanceReview({directory:false, resolve: resolver.resolveArticleContent});
  for (const source of ["naver_web", "daum_web"]) {
    const raw = candidate({source}), assessed = await review.assess(raw);
    assert.equal(assessed.decision.status, "related");
    assert.equal(assessed.article.url, raw.url);
    assert.equal(assessed.article.source, source);
    assert.equal(assessed.article.publishedAt, raw.publishedAt);
  }
  assert.equal(calls, 1);
});
test("HTTP errors and request limits preserve pending candidates across restarts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "nodeul-relevance-"));
  let now = Date.parse("2026-10-15T00:00:00Z"), calls = 0;
  const resolver = createPublisherResolver({...transportOptions, now: () => now, transport: async () => {calls++;return {status:403,headers:{},body:"Forbidden"};}});
  const first = await createRelevanceReview({directory, now: () => now, resolve: resolver.resolveArticleContent});
  assert.equal((await first.assess(candidate())).decision.status, "pending");
  assert.equal((await first.assess(candidate({url:"https://www.seoul.co.kr/news/b"}))).decision.status, "pending");
  assert.equal(calls, 1, "blocked host stops subsequent requests");
  const second = await createRelevanceReview({directory, now: () => now, maxRequests:0});
  assert.equal(second.retryCandidates("2026-01-01", "2026-10-01").length, 0);
  now += 6 * 3600_000 + 1;
  assert.equal(second.retryCandidates("2026-01-01", "2026-10-01").length, 2);
  assert.equal((await readRelevanceReviews(directory)).length, 2);
  await second.delivered(candidate());
  assert.equal(second.retryCandidates("2026-01-01", "2026-10-01").length, 1);
});
test("private redirect targets are blocked and body requests use a shared hop budget", async () => {
  let calls = 0;
  const resolver = createPublisherResolver({...transportOptions, transport: async () => {calls++;return {status:302,headers:{location:"http://127.0.0.1/private"},body:""};}});
  const value = await resolver.resolveArticleContent("https://www.seoul.co.kr/a");
  assert.match(value.evidence.join(" "), /private-address/);
  assert.equal(calls, 1);
  const zero = await resolver.resolveArticleContent("https://www.seoul.co.kr/b", {maxRequests:0});
  assert.ok(zero.evidence.includes("request-budget"));
  assert.equal(calls, 1);
});
test("single and bulk jobs persist only confirmed candidates and keep distinct URL spellings", async () => {
  process.env.DATABASE_URL ??= "postgres://localhost/test";
  const {runCrawlJob} = await import("./crawlOrchestrator");
  const {runBulkCrawlJob} = await import("./bulkCrawlOrchestrator");
  for (const run of [runCrawlJob, runBulkCrawlJob]) {
    const inserted: ArticleData[] = [], updates: Record<string, unknown>[] = [];
    const database = {select:()=>({from:async()=>[]}),update:()=>({set:(v:Record<string,unknown>)=>{updates.push(v);return {where:async()=>{}};}}),insert:()=>({values:async(v:ArticleData)=>{inserted.push(v);}})};
    const raw = [candidate(), candidate({source:"daum_web"}), candidate({url: "https://www.seoul.co.kr/news/a?from=daum#story"}), candidate({title:"노들역 승강기 교체",url:"https://paper.example/station"}), candidate({url:"https://paper.example/blocked"})];
    await run("review-test", "2026-04-01", "2026-04-30", {
      db:database as never, crawlNaverNews:async()=>[], crawlNaverWebSearch:async()=>raw, crawlDaumNews:async()=>[],crawlAllSources:async()=>[],analyzeArticleSentiment:async()=>false,
      createRelevanceReview:()=>createRelevanceReview({directory:false,resolve:async(url)=>({originalUrl:url,publisher:null,status:"partial",evidence:[],articleText:url.includes('blocked')?undefined:url.includes('station')?'노들역 승강기 교체':'노들예술섬에서 공연 개최',textComplete:!url.includes('blocked')})}),
    });
    assert.equal(inserted.length, 3);
    assert.deepEqual(inserted.map(a=>[a.source,a.url]), raw.slice(0,3).map(a=>[a.source,a.url]));
    assert.match(String(updates.at(-1)?.error), /무관 확인 1, 확인 대기 1/);
  }
});

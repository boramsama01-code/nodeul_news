import test from "node:test";
import assert from "node:assert/strict";
import { createPublisherResolver, inspectPublisherPage, formatMediaName } from "./publisherResolver";
test('Google browser collection retains portal and publisher labels',()=>{
 assert.equal(formatMediaName('google_news_web','연합뉴스'),'구글뉴스(연합뉴스)');
});
test('homepage publisher labels resolve offline without changing exact collection URLs',async()=>{
 let calls=0;
 const resolver=createPublisherResolver({cachePath:false,transport:async()=>{calls++;throw new Error('unexpected network');}});
 const base={title:'노들섬 행사',content:'',publishedAt:new Date('2026-01-01'),isNegative:false,isSelfPR:false,source:'google_news_rss',mediaName:'구글뉴스(기타)'};
 const labels=['https://www.didimkorea.net/','https://www.2news.co.kr/','www.cosmopolitan.co.kr','https://v.daum.net/','https://unknown.example/'];
 const input=labels.map((label,i)=>({...base,url:`https://news.google.com/rss/articles/${i}?oc=5#keep`,content:`노들섬 행사  ${label}`}));
 const result=await resolver.enrichArticles(input,{network:false});
 assert.deepEqual(result.map(a=>a.mediaName),['구글뉴스(디딤코리아)','구글뉴스(에너지뉴스)','구글뉴스(코스모폴리탄 코리아)','구글뉴스(기타)','구글뉴스(기타)']);
 assert.deepEqual(result.map(a=>a.url),input.map(a=>a.url));assert.equal(calls,0);
 assert.equal((await resolver.resolveArticleIdentity(input[0].url,'구글뉴스(https://www.didimkorea.net/)',{network:false})).publisher,'디딤코리아');
});
import { resolveMediaNameStrict, cleanPublisherName } from "./crawlerUtils";
import { googlePublisher } from "./crawlerSources";
import { parseOfficialDocument, loadOfficialFeed, coverageForRange } from "./sourceFeeds";
const options = {cachePath:false as const, hostDelayMs:0, lookup:async () => [{address:"8.8.8.8",family:4}]};
test('publisher enrichment preserves the collection URL and restores legacy Google publisher labels',async()=>{
 const resolver=createPublisherResolver({...options,transport:async()=>({status:200,headers:{},body:'<meta property="og:site_name" content="Daum | 연합뉴스"><a class="link_origin" href="https://yna.co.kr/view/A">기사원문</a>'})});
 const base={title:'노들섬 행사',content:'노들섬 행사',publishedAt:new Date('2026-01-01'),isNegative:false,isSelfPR:false};
 const daum={...base,url:'http://v.daum.net/v/20260101120000000?x=1#x',source:'daum_web',mediaName:'다음뉴스'};
 const google={...base,url:'https://news.google.com/rss/articles/opaque?oc=5',source:'google_news_rss',mediaName:'구글뉴스-노들(최신)',title:'노들섬 행사 - 연합뉴스',content:'노들섬 행사  연합뉴스'};
 const result=await resolver.enrichArticles([daum,google]);assert.equal(result[0].url,daum.url);assert.equal(result[0].mediaName,'다음뉴스(연합뉴스)');assert.equal(result[1].url,google.url);assert.equal(result[1].mediaName,'구글뉴스(연합뉴스)');
});
test("longest publisher domain and portal exclusions", () => {
  assert.equal(resolveMediaNameStrict("https://m.tenasia.hankyung.com/news"), "텐아시아");
  assert.equal(resolveMediaNameStrict("https://sportsworldi.com/news"), "스포츠월드");
  assert.equal(resolveMediaNameStrict("https://n.news.naver.com/article/1"), "");
  assert.equal(cleanPublisherName("최신"), "");
  assert.equal(cleanPublisherName("Google 뉴스"), "");
});
test("Google portal branding cannot replace the collection's publisher", async () => {
  const resolver=createPublisherResolver({...options,transport:async()=>({status:200,headers:{},body:'<meta property="og:site_name" content="Google 뉴스">'})});
  const url="https://news.google.com/rss/articles/sample";
  assert.equal((await resolver.resolveArticleIdentity(url,"구글뉴스(서울신문)")).publisher,"서울신문");
  assert.equal((await resolver.resolveArticleIdentity(url,"구글뉴스(문화일보)")).publisher,"문화일보");
});
test("JSON-LD graph publisher reference and matching metadata", () => {
  const page = inspectPublisherPage('<script type="application/ld+json">{"@graph":[{"@type":"NewsArticle","publisher":{"@id":"#p"}},{"@id":"#p","@type":"Organization","name":"테스트신문"}]}</script><meta property="og:site_name" content="테스트신문">', "https://paper.example/a");
  assert.equal(page.publisher, "테스트신문"); assert.equal(page.aliasEligible,true);
});
test("explicit portal origin followed, concurrent duplicates share requests", async () => {
  let calls=0;
  const resolver=createPublisherResolver({...options,transport:async () => {calls++; return {status:200,headers:{},body:'<a class="media_end_head_origin_link" href="https://yna.co.kr/view/AKR123">기사원문</a>'};}});
  const results=await Promise.all([resolver.resolveArticleIdentity("https://n.news.naver.com/article/1"),resolver.resolveArticleIdentity("https://n.news.naver.com/article/1")]);
  assert.equal(calls,1); assert.equal(results[0].publisher,"연합뉴스"); assert.equal(results[0].originalUrl,"https://yna.co.kr/view/AKR123");
});
test("redirect to private address is blocked without fetching it", async () => {
  let calls=0;
  const resolver=createPublisherResolver({...options,transport:async () => {calls++; return {status:302,headers:{location:"http://127.0.0.1/secret"},body:""};}});
  const result=await resolver.resolveArticleIdentity("https://paper.example/a");
  assert.equal(calls,1); assert.equal(result.status,"blocked");
});
test("negative responses cached and zero budget sends no request", async () => {
  let calls=0;
  const resolver=createPublisherResolver({...options,transport:async () => {calls++; return {status:404,headers:{},body:""};}});
  await resolver.resolveArticleIdentity("https://paper.example/a"); await resolver.resolveArticleIdentity("https://paper.example/a");
  await resolver.resolveArticleIdentity("https://paper.example/b", undefined,{maxRequests:0}); assert.equal(calls,1);
});
test("Google source field outranks ambiguous title suffix", () => {
  assert.deepEqual(googlePublisher({title:"노들섬 - 기획 - 테스트신문",source:{_:"테스트신문"}}),{title:"노들섬 - 기획",publisher:"테스트신문"});
});
test("Atom parses and generic sitemap lastmod is not publication date", async () => {
  const atom=await parseOfficialDocument('<feed xmlns="http://www.w3.org/2005/Atom"><title>신문</title><entry><title>노들섬</title><link href="https://paper.example/a"/><updated>2026-09-21T00:00:00Z</updated><id>a</id></entry></feed>',"https://paper.example/feed");
  assert.equal(atom.kind,"atom"); assert.equal(atom.items.length,1);
  const map=await parseOfficialDocument('<urlset><url><loc>https://paper.example/a</loc><lastmod>2025-01-01</lastmod></url></urlset>',"https://paper.example/map"); assert.equal(map.items.length,0);
});
test("HTML feed discovers advertised Atom within request budget", async () => {
  const result=await loadOfficialFeed({name:"신문",method:"rss_direct",url:"https://paper.example/rss",domain:"paper.example"},{maxRequests:4,fetch:async url => ({status:200,url,body:url.endsWith("/atom")?'<feed xmlns="http://www.w3.org/2005/Atom"><title>신문</title><entry><title>노들섬</title><link href="https://paper.example/a"/><updated>2026-09-21T00:00:00Z</updated><id>a</id></entry></feed>':'<html><head><link rel="alternate" type="application/atom+xml" href="/atom"></head></html>'})});
  assert.equal(result.feed.items.length,1); assert.equal(result.status,"partial"); assert.ok(result.requestCount<=4); assert.equal(coverageForRange(result,"2025-01-01","2025-01-14"),"outside_range");
});

test('legacy RSS description resolves publisher domains and ignores related story sources',async()=>{
 const resolver=createPublisherResolver(options);
 const base={title:'노들섬 행사',content:'',publishedAt:new Date('2026-01-01'),isNegative:false,isSelfPR:false,source:'google_news_rss',mediaName:'구글뉴스(기타)'};
 const input=[{...base,url:'https://news.google.com/rss/articles/one?oc=5',content:'노들섬 행사\u00a0\u00a0news.tf.co.kr'},{...base,url:'https://news.google.com/rss/articles/two',content:'노들섬 행사  투데이코리아'},{...base,url:'https://news.google.com/rss/articles/three',content:'노들섬 행사  v.daum.net\n관련기사  연합뉴스'}];
 const result=await resolver.enrichArticles(input,{network:false});
 assert.equal(result[0].mediaName,'구글뉴스(더팩트)');assert.equal(result[1].mediaName,'구글뉴스(투데이코리아)');assert.equal(result[2].mediaName,'구글뉴스(기타)');assert.deepEqual(result.map(a=>a.url),input.map(a=>a.url));
});

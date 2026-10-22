import { test } from "node:test";
import assert from "node:assert/strict";
process.env.DATABASE_URL ??= "postgres://localhost/test";
const candidate = {title:"노들섬 행사",content:"노들섬",url:"https://example.com/article",publishedAt:new Date("2025-01-05T03:00:00Z"),source:"google_news_rss",mediaName:"구글뉴스(서울신문)",isNegative:false,isSelfPR:false};

for (const deleted of [false, true]) test(`existing URL with improved press: deleted=${deleted}`, async () => {
  const { loadExistingArticles } = await import("./existingArticles");
  const changes: unknown[] = [];
  const row = {...candidate,id:1,mediaName:"구글뉴스(기타)",deletedAt:deleted ? new Date() : null};
  const fake = {
    select:()=>({from:async()=>[row]}),
    update:()=>({set:(value:unknown)=>{changes.push(value);return {where:()=>({returning:async()=>[{id:1}]})};}}),
  };
  const index = await loadExistingArticles(fake as never);
  assert.equal(await index.duplicate(candidate),true);
  assert.equal(await index.duplicate({...candidate,url:"https://publisher.example/original"},candidate.url),true);
  assert.deepEqual(changes, deleted ? [] : [{mediaName:candidate.mediaName}]);
  assert.match(index.summary(),deleted ? /휴지통 중복 제외 2건/ : /언론사 보정 1건/);
  assert.equal(await index.duplicate({...candidate,url:"https://example.com/other",title:"다른 노들섬 기사"}),false);
});

test("a known existing publisher is preserved and a successful insertion is remembered", async () => {
  const { loadExistingArticles } = await import("./existingArticles");
  const fake={select:()=>({from:async()=>[{...candidate,id:2,deletedAt:null}]}),update:()=>{throw new Error("must not update known publisher");}};
  const index=await loadExistingArticles(fake as never);
  assert.equal(await index.duplicate({...candidate,mediaName:"구글뉴스(기타)"}),true);
  const fresh={...candidate,url:"https://example.com/new",title:"새로운 노들섬 기사"};
  assert.equal(await index.duplicate(fresh),false);
  index.remember(fresh);
  assert.equal(await index.duplicate(fresh),true);
});

test('different collection sources and URL spellings remain separate records',async()=>{
 const {loadExistingArticles}=await import('./existingArticles');const row={...candidate,id:20,url:'http://www.news1.kr/photos/7882298?utm_source=portal',source:'naver_web',deletedAt:null};const index=await loadExistingArticles({select:()=>({from:async()=>[row]})} as never);
 assert.equal(await index.duplicate({...candidate,url:row.url,source:'naver_web'}),true);
 for(const source of ['naver_web','daum_web','publisher_search'])assert.equal(await index.duplicate({...candidate,url:'https://www.news1.kr/photos/7882298',source}),false);
 assert.equal(await index.duplicate({...candidate,url:row.url,source:'publisher_search'}),false);
});

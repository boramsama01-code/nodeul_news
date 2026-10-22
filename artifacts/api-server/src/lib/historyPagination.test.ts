import test from 'node:test';
import assert from 'node:assert/strict';
import axios from 'axios';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {extractNaverWebArticles,naverNextPage,naverPageHtml,crawlNaverWebSearch,crawlDaumNews} from './crawlerSources';
import {addToSet,isDuplicate} from './crawlerUtils';
const card=(title:string,date:string,url:string,press='검증신문')=>`<div><div class="sds-comps-profile-info-title-text">${press}새 창 열림</div><span class="sds-comps-profile-info-subtext">${date}</span><a data-heatmap-target=".tit" href="${url}">${title}새 창 열림</a><a data-heatmap-target=".body" href="${url}">노들섬 관련 보도</a></div>`;
test('Naver dates and publishers stay inside their own article card',()=>{
 const rows=extractNaverWebArticles(card('첫 기사','2026.01.30.','https://paper.example/a')+card('다음 기사','2026.01.02.','https://paper.example/b','다른신문'));
 assert.deepEqual(rows.map(a=>[a.title,a.dateStr,a.publisher]),[['첫 기사','2026-01-30','검증신문'],['다음 기사','2026-01-02','다른신문']]);
});
test('Naver follows the advertised cursor and parses its collection HTML',async()=>{
 const next='https://s.search.naver.com/p/newssearch/4/api/tab/more?start=11&query='+encodeURIComponent('노들섬')+'&ds=2026.01.01&de=2026.01.31&pd=3';
 assert.equal(naverNextPage('<script>'+JSON.stringify({url:next})+'</script>'),next);
 assert.equal(naverNextPage({url:'https://untrusted.example/more'}),null);
 assert.equal(naverPageHtml({collection:[{html:'one'},{html:'two'}]}),'one\ntwo');
 const original=axios.get;const calls:string[]=[];
 axios.get=(async(url:string,config:{params?:{query:string}})=>{if(config.params && config.params.query!=='노들섬')return {data:'검색결과가 없습니다'};calls.push(url);return {data:calls.length===1 ? card('노들섬 첫 기사','2026.01.30.','https://paper.example/a')+'<script>'+JSON.stringify({url:next})+'</script>' : {collection:[{html:card('노들섬 다음 기사','2026.01.02.','https://paper.example/b')}],url:null}};}) as typeof axios.get;
 try {assert.equal((await crawlNaverWebSearch('2026-01-01','2026-01-31')).length,2);assert.deepEqual(calls,['https://search.naver.com/search.naver',next]);} finally {axios.get=original;}
});
test('Daum uses p pagination and stops at the advertised last page',async()=>{
 const original=axios.get;const pages:number[]=[];
 axios.get=(async(_url:string,{params}:{params:{p:number;q:string}})=>{if(params.q!=='노들섬')return {data:'검색결과가 없습니다'};pages.push(params.p);return {data:`<li><div><div class="item-title"><a href="https://v.daum.net/v/2026010${params.p}120000000">노들섬 기사 ${params.p}</a></div></div></li><script>pageNavigation: {totalPage:2}</script>`};}) as typeof axios.get;
 try {assert.equal((await crawlDaumNews('2026-01-01','2026-01-31')).length,2);assert.deepEqual(pages,[1,2]);}finally{axios.get=original;}
});
test('Daum CAPTCHA stops subsequent months and repeated runs',async()=>{
 const original=axios.get,oldDir=process.env.DATA_DIR,temp=await mkdtemp(join(tmpdir(),'nodeul-daum-test-'));let calls=0;process.env.DATA_DIR=temp;
 axios.get=(async()=>{calls++;return {status:200,data:'<script> location.replace("https://captcha.search.daum.net/show?redirect=x"); </script>'};}) as typeof axios.get;
 try{assert.deepEqual(await crawlDaumNews('2026-04-01','2026-09-27'),[]);assert.deepEqual(await crawlDaumNews('2026-01-01','2026-01-31'),[]);assert.equal(calls,1);}finally{axios.get=original;if(oldDir===undefined)delete process.env.DATA_DIR;else process.env.DATA_DIR=oldDir;await rm(temp,{recursive:true,force:true});}
});
test('Daum explicit zero pages keeps first-page articles without requesting a repeated page',async()=>{
 const original=axios.get;let calls=0;
 axios.get=(async(_url:string,{params}:{params:{q:string}})=>{if(params.q!=='노들섬')return {data:'검색결과가 없습니다'};calls++;return {status:200,data:'<li><div class="item-title"><a href="https://v.daum.net/v/20261001120000000">노들섬 기사</a></div></li><script>pageNavigation: { totalPage: 0, currentPage: 1 }</script>'};}) as typeof axios.get;
 try {assert.equal((await crawlDaumNews('2026-10-01','2026-10-01')).length,1);assert.equal(calls,1);}finally{axios.get=original;}
});

test('different URLs never collide by headline or Korean day',()=>{
 const set=new Set<string>();const early=new Date('2026-01-01T16:00:00Z'),late=new Date('2026-01-02T03:00:00Z');
 addToSet('https://a.example/1','노들섬 사진',early,set,'naver_web','네이버(기타)');
 assert.equal(isDuplicate('https://b.example/2','노들섬 사진',early,set,'naver_web','네이버(기타)'),false);
 addToSet('https://a.example/3','노들섬 공연새 창 열림',early,set,'google_news_rss','구글뉴스(신문)');
 assert.equal(isDuplicate('https://a.example/4','노들섬 공연',late,set,'google_news_rss','구글뉴스(신문)'),false);
 addToSet('https://photo.example/1','노들섬 사진',early,set,'naver_web','네이버(신문)');
 assert.equal(isDuplicate('https://photo.example/2','노들섬 사진',early,set,'naver_web','네이버(신문)'),false);
});

test('week labels remain unresolved until an exact single-day search',()=>{
 const html=card('노들섬 공연','3주 전','https://paper.example/weeks');
 assert.equal(extractNaverWebArticles(html)[0].dateStr,'');
 assert.equal(extractNaverWebArticles(html,'2026-08-31')[0].dateStr,'2026-08-31');
});
test('multi-day search with week labels narrows to each requested day',async()=>{
 const original=axios.get;const ranges:string[]=[];
 axios.get=(async(_url:string,{params}:{params:{ds:string;de:string;query:string;start:number}})=>{if(params.query!=='노들섬' || params.start>1)return {data:'검색결과가 없습니다'};ranges.push(params.ds+'~'+params.de);return {data:card('노들섬 공연','3주 전','https://paper.example/'+params.ds)}}) as typeof axios.get;
 try {const rows=await crawlNaverWebSearch('2026-08-30','2026-08-31');assert.deepEqual(rows.map(a=>a.publishedAt.toISOString().slice(0,10)),['2026-08-30','2026-08-31']);assert.deepEqual(ranges,['2026.08.30~2026.08.31','2026.08.30~2026.08.30','2026.08.31~2026.08.31']);}finally{axios.get=original;}
});

test('Naver pagination accepts versioned official endpoints only',()=>{
 for(const version of [3,4,5])assert.equal(naverNextPage({url:`https://s.search.naver.com/p/newssearch/${version}/api/tab/more?start=11`}),`https://s.search.naver.com/p/newssearch/${version}/api/tab/more?start=11`);
 assert.equal(naverNextPage({url:'https://s.search.naver.com.evil.example/p/newssearch/4/api/tab/more'}),null);
 assert.equal(naverNextPage({url:'https://s.search.naver.com/p/newssearch/4/api/tab/cookie'}),null);
});

test('Naver HTTP 200 CAPTCHA pauses later requests instead of reporting empty results',async()=>{
 const original=axios.get,oldDir=process.env.DATA_DIR,temp=await mkdtemp(join(tmpdir(),'nodeul-naver-challenge-'));let calls=0;process.env.DATA_DIR=temp;
 axios.get=(async()=>{calls++;return {status:200,data:'<html><body>검색 서비스 이용이 제한되었습니다 <div class="g-recaptcha">보안 절차</div></body></html>'};}) as typeof axios.get;
 try{assert.deepEqual(await crawlNaverWebSearch('2026-10-01','2026-10-01'),[]);assert.deepEqual(await crawlNaverWebSearch('2026-10-01','2026-10-01'),[]);assert.equal(calls,1);const {readProviderHealth}=await import('./providerHealth');const state=(await readProviderHealth()).naver_web;assert.equal(state.status,'limited');assert.ok(Date.parse(state.blockedUntil!)-Date.now()>5*3600_000);}
 finally{axios.get=original;if(oldDir===undefined)delete process.env.DATA_DIR;else process.env.DATA_DIR=oldDir;await rm(temp,{recursive:true,force:true});}
});

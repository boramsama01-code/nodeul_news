import test from 'node:test';import assert from 'node:assert/strict';
import {createGoogleFeedTransport,classifyProviderResponse,type ProviderHealth} from './providerHealth';
test('normal Naver results with dormant captcha API configuration stay available',()=>{
 const html='<html><head><title>노들 뉴스검색</title></head><body><a href="https://example.com/news">노들섬 기사</a><script>var config={captchaApi:{image:"https://captcha.nid.naver.com/nhncaptchav4.gif",check:"/api/v1/captcha"}};</script></body></html>';
 assert.equal(classifyProviderResponse(200,html).kind,'http');
 assert.equal(classifyProviderResponse(200,'<html><body><input id="inpDkaptcha" placeholder="정답을 입력해주세요"></body></html>').kind,'challenge');
 assert.equal(classifyProviderResponse(403,'<html><body>검색 서비스 이용이 제한되었습니다</body></html>').kind,'challenge');
});
test('Daum script-only challenge redirect is recognized without mistaking news text',()=>{
 assert.equal(classifyProviderResponse(200,'<script type="text/javascript"> location.replace("https://captcha.search.daum.net/show?redirect=x"); </script>').kind,'challenge');
 assert.equal(classifyProviderResponse(200,'<rss><title>captcha.search.daum.net 관련 기사</title></rss>').kind,'http');
});
test('Google actual automated-query response persists and blocks queued and recreated clients',async()=>{
 let now=100000,calls=0;let state:Record<string,ProviderHealth>={};
 const options={read:async()=>state,save:async(k:string,v:ProviderHealth)=>{state[k]=v;},now:()=>now,gapMs:0,get:async()=>{calls++;return {status:503,data:'<html>Sorry, your computer or network may be sending automated queries.</html>',headers:{}};}};
 const client=createGoogleFeedTransport(options);const result=await Promise.allSettled([client('a'),client('b'),client('c')]);assert.ok(result.every(r=>r.status==='rejected'));assert.equal(calls,1);assert.equal(state.google_news.status,'limited');
 await assert.rejects(createGoogleFeedTransport(options)('d'),/요청 휴식/);assert.equal(calls,1);
 now+=6*3600_000+1;await assert.rejects(client('e'),/자동 검색/);assert.equal(calls,2);
});
test('RSS news text about captcha is not a challenge page',async()=>{
 const xml='<rss><channel><item><title>Unusual traffic and CAPTCHA news</title></item></channel></rss>';
 const client=createGoogleFeedTransport({read:async()=>({}),save:async()=>{},gapMs:0,get:async()=>({status:200,data:xml,headers:{}})});assert.equal(await client('a'),xml);
 assert.equal(classifyProviderResponse(403,'Forbidden').kind,'forbidden');assert.equal(classifyProviderResponse(429,'Too many requests').kind,'rate');
});
test('Retry-After is honored when longer than the default pause',async()=>{
 let state:ProviderHealth|undefined;
 const client=createGoogleFeedTransport({read:async()=>({}),save:async(_,v)=>{state=v;},now:()=>100000,gapMs:0,get:async()=>({status:429,data:'Too many requests',headers:{'retry-after':'3600'}})});
 await assert.rejects(client('a'));assert.equal(Date.parse(state!.blockedUntil!),3700000);
});

test('health file failure preserves cooldown in memory without failing collection',async()=>{
 const {mkdtemp,writeFile,rm}=await import('node:fs/promises');const {join}=await import('node:path');const {tmpdir}=await import('node:os');
 const {recordProviderHealth,readProviderHealth}=await import('./providerHealth');
 const dir=await mkdtemp(join(tmpdir(),'nodeul-health-')),old=process.env.DATA_DIR;const blocked=join(dir,'not-a-directory');await writeFile(blocked,'fixture');process.env.DATA_DIR=blocked;
 try{await recordProviderHealth('google_news',{status:'limited',reason:'test cooldown',checkedAt:new Date().toISOString(),blockedUntil:'2099-01-01T00:00:00Z'});assert.equal((await readProviderHealth()).google_news.reason,'test cooldown');}
 finally{if(old===undefined)delete process.env.DATA_DIR;else process.env.DATA_DIR=old;await rm(dir,{recursive:true,force:true});}
});

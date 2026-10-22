import {mkdir,readFile,writeFile,rename} from 'node:fs/promises';
import {join,dirname} from 'node:path';
import axios from 'axios';
import {logger} from './logger';
import * as cheerio from 'cheerio';
import {readState, writeState, usesDatabaseState} from './persistentState';

export interface ProviderHealth {
  status:'ok'|'limited'|'error'; reason:string; checkedAt:string;
  httpStatus?:number; responseEvidence?:string; blockedUntil?:string; lastFailure?:{reason:string;at:string;httpStatus?:number};
}
export function providerResponseEvidence(body:string):string {
  const $=cheerio.load(body.slice(0,200_000));$('script,style,noscript').remove();return $('body').text().replace(/\s+/g,' ').trim().slice(0,1200);
}
export function classifyProviderResponse(status:number,body:string) {
  if (/<script\b[^>]*>\s*(?:window\.)?location\.replace\(\s*["']https:\/\/captcha\.search\.daum\.net\//i.test(body)) return {kind:'challenge' as const,reason:'다음 검색에서 사람 확인(CAPTCHA) 페이지로 이동 요청'};
  const errorPage=status!==200 || /<html\b/i.test(body);
  // Search pages include dormant CAPTCHA API configuration in scripts. Only
  // rendered challenge controls or an actual restriction message are evidence.
  if (errorPage) {
    const $=cheerio.load(body);$('script,style,noscript').remove();
    const text=$('body').text().replace(/\s+/g,' ').trim();
    const heading=$('title,h1,h2').text();
    if (/automated queries|unusual traffic|비정상적인 트래픽/i.test(text)) return {kind:'automated' as const,reason:'자동 검색 요청 감지로 컴퓨터 또는 네트워크 접근 제한'};
    const control=$('iframe[src*="captcha"], .g-recaptcha[data-sitekey], .h-captcha[data-sitekey], input[name*="captcha"], input[id*="captcha"], input[id="inpDkaptcha"], img[src*="captcha"]').length>0;
    const message=/captcha|자동입력 방지|보안문자|사람인지 확인/i.test(heading) || /검색 서비스 이용이 제한되었습니다/.test(text);
    if(control || message) return {kind:'challenge' as const,reason:'응답에서 사람 확인(CAPTCHA) 신호 감지'};
  }
  if(status===429) return {kind:'rate' as const,reason:'요청 횟수 제한'};
  if(status===403) return {kind:'forbidden' as const,reason:'접근 거부 — 응답에서 구체적 제한 사유를 확인하지 못함'};
  return {kind:'http' as const,reason:`HTTP ${status} 응답`};
}
const healthPath=()=>join(process.env.DATA_DIR||'.local','provider-health.json');
let writes:Promise<unknown>=Promise.resolve();
const memoryHealth=new Map<string,Record<string,ProviderHealth>>();
export async function readProviderHealth():Promise<Record<string,ProviderHealth>> {
  const file=healthPath();let stored:Record<string,ProviderHealth>={};
  if(usesDatabaseState()) stored=await readState<Record<string,ProviderHealth>>('provider-health') || {};
  else try{stored=JSON.parse(await readFile(file,'utf8'));}catch{}
  for(const [key,value] of Object.entries(memoryHealth.get(file)||{})){
    if(!stored[key] || Date.parse(value.checkedAt)>=Date.parse(stored[key].checkedAt))stored[key]=value;
  }
  return stored;
}
export function recordProviderHealth(provider:string,value:ProviderHealth):Promise<void> {
  const task=writes.catch(()=>{}).then(async()=>{
    const all=await readProviderHealth(),previous=all[provider];
    all[provider]={...value,lastFailure:value.status==='ok' ? previous?.lastFailure : {reason:value.reason,at:value.checkedAt,httpStatus:value.httpStatus}};
    const file=healthPath();memoryHealth.set(file,all);
    // Diagnostic storage must not discard collected articles; retain cooldowns in memory.
    try{
      if(usesDatabaseState()) {await writeState('provider-health',all);return;}
      await mkdir(dirname(file),{recursive:true});
      const temporary=file+'.'+process.pid+'.tmp';await writeFile(temporary,JSON.stringify(all,null,2));
      for(let attempt=0;;attempt++){
        try{await rename(temporary,file);break;}catch(err){
          if(attempt>=3 || !['EPERM','EBUSY','EACCES'].includes((err as NodeJS.ErrnoException).code||''))throw err;
          await new Promise(resolve=>setTimeout(resolve,100*(attempt+1)));
        }
      }
    }catch(err){logger.warn({err,provider},'Provider health persistence failed; retained in memory');}
  });
  writes=task;return task;
}

type Response={status:number;data:string;headers:Record<string,unknown>};
export function createGoogleFeedTransport(options:{
  read?:()=>Promise<Record<string,ProviderHealth>>;
  save?:(provider:string,state:ProviderHealth)=>Promise<void>;
  get?:(url:string)=>Promise<Response>;now?:()=>number;gapMs?:number;
}={}) {
  const read=options.read||readProviderHealth,save=options.save||recordProviderHealth,now=options.now||Date.now;
  const get=options.get|| (async(url:string)=>{
    const r=await axios.get<string>(url,{timeout:12000,responseType:'text',maxContentLength:3*1024*1024,maxRedirects:3,validateStatus:()=>true,headers:{Accept:'application/rss+xml, application/xml, text/xml', 'User-Agent':'NodeulNews/1.0 (local news monitor)'}});
    return {status:r.status,data:r.data,headers:r.headers};
  });
  let queue:Promise<unknown>=Promise.resolve(),lastRequest=0;
  return (url:string):Promise<string>=>{
    const request=queue.catch(()=>{}).then(async()=>{
      const state=(await read()).google_news;
      if(state?.blockedUntil && Date.parse(state.blockedUntil)>now()) throw new Error(`${state.reason}. 앱의 요청 휴식 중 (${state.blockedUntil}까지). 다른 수집처는 계속 사용합니다.`);
      const wait=Math.max(0,(options.gapMs??1500)-(now()-lastRequest));
      if(wait)await new Promise(resolve=>setTimeout(resolve,wait));
      lastRequest=now();
      let response:Response;
      try{response=await get(url);}catch(error){
        await save('google_news',{status:'error',reason:'네트워크 연결 또는 응답 시간 초과',checkedAt:new Date(now()).toISOString(),blockedUntil:new Date(now()+15*60_000).toISOString()});
        throw error;
      }
      const body=String(response.data),classification=classifyProviderResponse(response.status,body);
      if(response.status!==200 || /<html\b/i.test(body) || ['automated','challenge'].includes(classification.kind)){
        const automated=['automated','challenge'].includes(classification.kind);
        const retry=Number(response.headers['retry-after']);
        const cooldown=Math.max(automated?6*3600_000:15*60_000,Number.isFinite(retry)?retry*1000:0);
        const reason=response.status===200&&classification.kind==='http'?'RSS 대신 HTML 페이지 반환':classification.reason;
        await save('google_news',{status:automated||[403,429].includes(response.status)?'limited':'error',reason,checkedAt:new Date(now()).toISOString(),httpStatus:response.status,responseEvidence:providerResponseEvidence(body),blockedUntil:new Date(now()+cooldown).toISOString()});
        throw new Error(`${reason} (HTTP ${response.status}). ${automated?'6시간':'최소 15분'} 동안 요청을 쉽니다.`);
      }
      await save('google_news',{status:'ok',reason:'RSS 정상 응답',checkedAt:new Date(now()).toISOString(),httpStatus:200});
      return body;
    });
    queue=request;return request;
  };
}
export const fetchGoogleFeedXml=createGoogleFeedTransport();

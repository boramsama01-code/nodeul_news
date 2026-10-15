import axios from 'axios';
import * as cheerio from 'cheerio';
import {createHash} from 'node:crypto';
import {mkdir,readFile,writeFile,rename} from 'node:fs/promises';
import {join} from 'node:path';
import {type ArticleData} from './crawlerUtils';
import {validateDateRange,warnSource,kstDate} from './crawlRuntime';
import {recordProviderHealth,readProviderHealth,classifyProviderResponse} from './providerHealth';
export type ArchiveSite='mk'|'seoul';
const sites={mk:{name:'매일경제',origin:'https://www.mk.co.kr',path:'/search/news'},seoul:{name:'서울신문',origin:'https://www.seoul.co.kr:8888',path:'/index.php'}};
export function archiveUrl(site:ArchiveSite,keyword:string,start:string,end:string,page=1):string {
 const u=new URL(sites[site].path,sites[site].origin);
 const params=site==='mk'?{word:keyword,sort:'desc',searchField:'all',dateType:'direct',startDate:start,endDate:end,pg:String(page)}:{keyword,sort:'desc',scope:'',cpCode:'seoul',period:'self',sDate:start,eDate:end,page:String(page)};
 for(const [k,v]of Object.entries(params))u.searchParams.set(k,v);return u.href;
}
function excerpt(text:string):string {text=text.replace(/\s+/g,' ').trim();const at=text.search(/노들|서울문화재단/);return text.slice(Math.max(0,at-100),Math.max(0,at-100)+420);}
function parseDate(text:string):Date|null {const m=text.match(/(\d{4})[-.](\d{2})[-.](\d{2})(?:\s+(\d{2}):(\d{2})(?::(\d{2}))?)?/);if(!m)return null;const day=`${m[1]}-${m[2]}-${m[3]}`;const date=new Date(`${day}T${m[4]||'12'}:${m[5]||'00'}:${m[6]||'00'}+09:00`);return Number.isFinite(date.getTime())&&kstDate(date)===day?date:null;}
export function parseArchivePage(site:ArchiveSite,html:string,url:string){
 const $=cheerio.load(html),rows:ArticleData[]=[];let invalid=0;
 const cards=site==='mk'?$('#list_area a.news_item'):$('.articleContentWrap');
 cards.each((_,el)=>{const card=$(el),a=site==='mk'?card:card.find('.articleTitle a').first();const href=a.attr('href');const title=(site==='mk'?card.find('.news_ttl').clone().find('.is_blind').remove().end():a.find('h2')).text().trim();
 const body=card.find(site==='mk'?'.news_desc':'.articleTitle .body16').text().trim();const date=parseDate(card.find(site==='mk'?'.time_info':'.ArticleInfo').text());
 if(!href||!title||!date){invalid++;return;}let link:URL;try{link=new URL(href,url);}catch{invalid++;return;}
 const host=site==='mk'?'mk.co.kr':'seoul.co.kr';if(!/^https?:$/.test(link.protocol)||!(link.hostname===host||link.hostname.endsWith('.'+host))||link.username||link.password){invalid++;return;}
 rows.push({url:link.href,title,content:excerpt(body),publishedAt:date,mediaName:sites[site].name,source:'publisher_search',isNegative:false,isSelfPR:false});});
 const current=new URL(url),page=Number(current.searchParams.get(site==='mk'?'pg':'page')||1);
 let next:string|null=null;
 if(site==='mk'){const total=Number(html.match(/\bconst\s+totalCount\s*=\s*(\d+)/)?.[1]);if(Number.isFinite(total)&&page*10<total){current.searchParams.set('pg',String(page+1));next=current.href;}}
 else{$('.pagination a[href]').each((_,e)=>{const candidate=new URL($(e).attr('href')!,url);if(candidate.origin===current.origin&&candidate.pathname===current.pathname&&Number(candidate.searchParams.get('page'))===page+1)next=candidate.href;});}
 return {rows:[...new Map(rows.map(r=>[r.url,r])).values()],next,invalid,cards:cards.length,recognized:cards.length>0 || /검색결과가 없습니다|검색 결과가 없습니다/.test($.text())};
}
const lastRequest=new Map<string,number>();
export async function requestArchiveHtml(url:string, get=(url:string)=>axios.get<string>(url,{timeout:30000,responseType:'text',maxRedirects:0,maxContentLength:3*1024*1024,validateStatus:()=>true,headers:{'User-Agent':'NodeulNews/1.0 (local news monitor)',Accept:'text/html'}}),retryDelayMs=1200):Promise<string>{
 let response:Awaited<ReturnType<typeof get>>;
 try{response=await get(url);}catch(error){
  // A slow archive response is not an access restriction. Retry one timed-out
  // GET only; HTTP restrictions and other failures keep the normal cooldown.
  if(!['ECONNABORTED','ETIMEDOUT'].includes((error as {code?:string}).code||''))throw error;
  await new Promise(resolve=>setTimeout(resolve,retryDelayMs));response=await get(url);
 }
 if(response.status!==200){const c=classifyProviderResponse(response.status,String(response.data));throw new Error(c.reason+' (HTTP '+response.status+')');}
 return String(response.data);
}
export function createArchiveCrawler(options:{get?:(url:string)=>Promise<string>;cacheDir?:string|false;delayMs?:number;maxPages?:number}={}){
 const pending=new Map<string,Promise<ReturnType<typeof parseArchivePage>>>();
 async function page(site:ArchiveSite,url:string){
  const key=createHash('sha256').update(url).digest('hex');const directory=options.cacheDir===false?null:options.cacheDir||join(process.env.DATA_DIR||'.local','archive-cache');const path=directory?join(directory,key+'.json'):null;
  if(path){try{const cached=JSON.parse(await readFile(path,'utf8'));if(cached.expires>Date.now())return {...cached.page,rows:cached.page.rows.map((r:ArticleData)=>({...r,publishedAt:new Date(r.publishedAt)}))} as ReturnType<typeof parseArchivePage>;}catch{}}
  if(pending.has(key))return pending.get(key)!;
  const task=(async()=>{const wait=Math.max(0,(options.delayMs??1200)-(Date.now()-(lastRequest.get(site)||0)));if(wait)await new Promise(r=>setTimeout(r,wait));lastRequest.set(site,Date.now());
   const html=await (options.get?options.get(url):requestArchiveHtml(url));
   const result=parseArchivePage(site,html,url);if(!result.recognized)throw new Error('검색 기사 요소를 확인하지 못함');if(path){await mkdir(directory!,{recursive:true});const temp=path+'.'+process.pid+'.tmp';await writeFile(temp,JSON.stringify({expires:Date.now()+86400000,page:result}));await rename(temp,path);}return result;
  })();pending.set(key,task);try{return await task;}finally{pending.delete(key);}
 }
 return async(site:ArchiveSite,start:string,end:string)=>{
  validateDateRange(start,end);const name=sites[site].name;const all:ArticleData[]=[];let issue='';const healthKey='archive_'+site;
  const state=(await readProviderHealth())[healthKey];if(!options.get&&state?.blockedUntil&&Date.parse(state.blockedUntil)>Date.now()){warnSource(name+' 자체검색',state.reason+' — 요청 휴식 중');return [];}
  try{for(const keyword of ['노들','노들섬']){let url:string|null=archiveUrl(site,keyword,start,end);const seen=new Set<string>();for(let count=0;url&&count<(options.maxPages??50);count++){
    if(seen.has(url)){issue='페이지 주소 반복';break;}seen.add(url);const result=await page(site,url);
    if(result.invalid)issue=`게시일 또는 기사 요소 확인 불가 ${result.invalid}건`;
    all.push(...result.rows.filter(a=>{const day=kstDate(a.publishedAt);return day>=start&&day<=end;}));
    url=result.next;if(url&&count===(options.maxPages??50)-1)issue='페이지 상한 도달: 일부 미확인';
   }}
   await recordProviderHealth(healthKey,{status:issue?'error':'ok',reason:`${start}~${end} 자체검색 ${new Set(all.map(a=>a.url)).size}건 확인${issue?' · '+issue:''}`,checkedAt:new Date().toISOString(),httpStatus:200});
  }catch(error){issue=String(error);await recordProviderHealth(healthKey,{status:/403|429|자동 검색|CAPTCHA/.test(issue)?'limited':'error',reason:issue,checkedAt:new Date().toISOString(),blockedUntil:new Date(Date.now()+3600000).toISOString()});}
  if(issue)warnSource(name+' 자체검색',issue);return [...new Map(all.map(a=>[a.url,a])).values()];
 };
}
const crawl=createArchiveCrawler();
export async function crawlOfficialArchives(start:string,end:string){const result:ArticleData[]=[];for(const site of ['mk','seoul'] as const)result.push(...await crawl(site,start,end));return result;}

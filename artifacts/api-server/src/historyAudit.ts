import { createRelevanceReview } from "./lib/relevanceReview";
import {crawlOfficialArchives} from "./lib/officialArchives";
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import axios from 'axios';
import {db,pool,articlesTable,crawlJobsTable} from '@workspace/db';
import {eq} from 'drizzle-orm';
import {crawlNaverWebSearch,crawlDaumNews,crawlSource} from './lib/crawlerSources';
import {NEWS_SOURCES} from './lib/rssFeedList';
import {crawlWarnings,shiftDate,validateDateRange,kstDate} from './lib/crawlRuntime';
import {withCrawlLock} from './lib/crawlLock';
import {loadExistingArticles} from './lib/existingArticles';
import {enrichArticles} from './lib/publisherResolver';
import {addToSet,ruleBasedSentiment,type ArticleData} from './lib/crawlerUtils';

const args=process.argv.slice(2);
const option=(key:string,fallback:string)=>args[args.indexOf(key)+1] && args.includes(key) ? args[args.indexOf(key)+1] : fallback;
const start=option('--start',`${kstDate().slice(0,4)}-01-01`),end=option('--end',kstDate());
validateDateRange(start,end);
const apply=args.includes('--apply');
const selected=option('--sources','naver,daum,google').split(',');
if(selected.some(s=>!['naver','daum','google','official'].includes(s)))throw Error('Unknown source');
const skip=()=>Promise.resolve({rows:[] as ArticleData[],warnings:[] as string[],splits:0});
const replay=option('--replay','');
const output=option('--output',join(process.env.DATA_DIR||'.local','reports',`history-${start}-${end}`));
await mkdir(output,{recursive:true});
const jobId=randomUUID();
const summaryFile=join(output,'summary.json');
const months:Array<{start:string;end:string}>=[];
for(let current=start;current<=end;){
 const d=new Date(current+'T00:00:00Z');
 const next=new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth()+1,1)).toISOString().slice(0,10);
 const last=shiftDate(next,-1);months.push({start:current,end:last<end?last:end});current=next;
}
let requests=0;
axios.interceptors.request.use(config=>{
 if(++requests>3500) {const error=new Error('점검 요청 예산 3500회 초과') as Error & {response:{status:number}};error.response={status:400};throw error;}
 return config;
});
const summary={jobId,start,end,apply,selected,startedAt:new Date().toISOString(),completedAt:null as string|null,requests:0,inserted:0,duplicates:0,failures:0,months:[] as Array<Record<string,unknown>>};
async function scan(name:string,fn:(s:string,e:string)=>Promise<ArticleData[]>,s:string,e:string,depth=0):Promise<{rows:ArticleData[];warnings:string[];splits:number}> {
 const warnings:string[]=[];
 const rows=await crawlWarnings.run(warnings,()=>fn(s,e));
 if(warnings.some(w=>/상한|반복/.test(w)) && s<e && depth<6){
  const days=Math.round((Date.parse(e)-Date.parse(s))/86400000);
  const mid=shiftDate(s,Math.floor(days/2));
  const a=await scan(name,fn,s,mid,depth+1),b=await scan(name,fn,shiftDate(mid,1),e,depth+1);
  const unique=new Map([...rows,...a.rows,...b.rows].map(row=>[row.url,row]));
  return {rows:[...unique.values()],warnings:[...a.warnings,...b.warnings],splits:1+a.splits+b.splits};
 }
 return {rows,warnings,splits:0};
}
try {
 await withCrawlLock(async()=>{
  const review=await createRelevanceReview({directory:apply?undefined:false,maxRequests:replay?0:60});
  const baseline=await db.select().from(articlesTable);
  await writeFile(join(output,`baseline-${jobId}.json`),JSON.stringify(baseline));
  if(apply)await db.insert(crawlJobsTable).values({id:jobId,status:'running',currentSource:'과거 누락 점검 시작',progress:0});
  for(const [monthIndex,month] of months.entries()){
   const file=join(output,month.start.slice(0,7)+'.json');
   if(args.includes('--resume')){try{const previous=JSON.parse(await readFile(file,'utf8'));if(previous.completed&&previous.apply===apply&&!previous.result.warnings?.length){summary.months.push(previous.result);summary.inserted+=previous.result.inserted;summary.duplicates+=previous.result.duplicates;summary.failures+=previous.result.failures;continue;}}catch{}}
   if(apply)await db.update(crawlJobsTable).set({currentSource:`과거 누락 점검 ${month.start}~${month.end}`,progress:Math.floor(monthIndex/months.length*95)}).where(eq(crawlJobsTable.id,jobId));
   console.log(JSON.stringify({month:month.start,stage:'collect'}));
   const google=NEWS_SOURCES.find(s=>s.domain==='news.google.com')!;
   const sources: Array<{rows:ArticleData[];warnings:string[];splits:number}>=replay
    ? JSON.parse(await readFile(join(replay,month.start.slice(0,7)+'.json'),'utf8')).sources.map((s:{rows:ArticleData[];warnings:string[];splits:number})=>({...s,rows:s.rows.map(a=>({...a,publishedAt:new Date(a.publishedAt)}))}))
    : await Promise.all([
    selected.includes('naver')?scan('naver',crawlNaverWebSearch,month.start,month.end):skip(),
    selected.includes('daum')?scan('daum',crawlDaumNews,month.start,month.end):skip(),
    !selected.includes('google') ? skip() : args.includes('--skip-google') ? Promise.resolve({rows:[] as ArticleData[],warnings:['구글뉴스: 자동 검색 제한이 확인되어 추가 요청 생략'],splits:0}) : scan('google',(s,e)=>crawlSource(google,s,e),month.start,month.end),
    selected.includes('official')?scan('official',crawlOfficialArchives,month.start,month.end):skip(),
   ]);
   const raw=sources.flatMap(s=>s.rows);
   await writeFile(file,JSON.stringify({apply,completed:false,month,sources},null,2));
   const rows=await db.select().from(articlesTable);
   const matchMap=new Map<string,typeof rows>();
   for(const row of rows){const keys=new Set<string>();addToSet(row.url,row.title,row.publishedAt,keys,row.source,row.mediaName);for(const key of keys){const list=matchMap.get(key)||[];list.push(row);matchMap.set(key,list);}}
   const exactUrls=new Set(rows.map(r=>r.url));
   const existing=await loadExistingArticles(db);
   // Reuse original URLs already verified in the database before requesting portal relays.
   const corroborated=raw.length ? (await enrichArticles([...rows.filter(r=>!r.deletedAt),...raw],{maxRequests:0})).slice(-raw.length) : [];
   const enriched=await enrichArticles(corroborated,{maxRequests:replay?0:(selected.length===1&&selected[0]==='google'?6:60)});
   const outcomes:Array<Record<string,unknown>>=[];
   let inserted=0,duplicates=0,failures=0,absentUrls=0;
   for(const [i,candidate] of enriched.entries()){
    let article=candidate;
    const keys=new Set<string>();addToSet(article.url,article.title,article.publishedAt,keys,article.source,article.mediaName);
    addToSet(raw[i].url,article.title,article.publishedAt,keys,article.source,article.mediaName);
    const matches=[...new Map([...keys].flatMap(k=>matchMap.get(k)||[]).map(r=>[r.id,r])).values()];
    const record:Record<string,unknown>={source:article.source,title:article.title,url:article.url,collectedUrl:raw[i].url,publishedAt:article.publishedAt,mediaName:article.mediaName,existingIds:matches.map(r=>r.id),trashIds:matches.filter(r=>r.deletedAt).map(r=>r.id)};
    if(!matches.length){
     const assessed=await review.assess(article);record.relevance=assessed.decision;
     if(assessed.decision.status!=='related'){record.disposition=assessed.decision.status;outcomes.push(record);continue;}
     article=assessed.article;
    }
    try{
     if(apply && await existing.duplicate(article,raw[i].url)){record.disposition='duplicate';duplicates++;if(apply)await review.delivered(article);}
     else if(!apply && matches.length){record.disposition='duplicate';duplicates++;}
     else if(apply){
      const [saved]=await db.insert(articlesTable).values({...article,isNegative:ruleBasedSentiment(article.title,article.content)}).returning();
      record.disposition='inserted';record.id=saved.id;inserted++;
      if(!exactUrls.has(article.url)&&!exactUrls.has(raw[i].url))absentUrls++;
      existing.remember(article);await review.delivered(article);
      for(const key of keys){const list=matchMap.get(key)||[];list.push(saved);matchMap.set(key,list);}
     }else{record.disposition='missing';}
    }catch(error){record.disposition='error';record.error=String(error);failures++;}
    outcomes.push(record);
   }
   const result={...month,coverage:sources.some(s=>s.warnings.length)?'partial':'checked',candidates:raw.length,naver:sources[0].rows.length,daum:sources[1].rows.length,google:sources[2].rows.length,official:sources[3]?.rows.length||0,inserted,duplicates,failures,absentUrls,relevance:review.summary(),corrections:existing.summary(),splits:sources.map(s=>s.splits),warnings:sources.flatMap(s=>s.warnings)};
   summary.inserted+=inserted;summary.duplicates+=duplicates;summary.failures+=failures;summary.requests=requests;summary.months.push(result);
   await writeFile(file,JSON.stringify({apply,completed:true,month,result,outcomes,sources},null,2));
   await writeFile(summaryFile,JSON.stringify(summary,null,2));
   if(apply)await db.update(crawlJobsTable).set({collected:summary.inserted,duplicates:summary.duplicates,total:summary.inserted+summary.duplicates,error:`과거 월별 누락 점검 진행 중. ${existing.summary()}`}).where(eq(crawlJobsTable.id,jobId));
   console.log(JSON.stringify(result));
  }
  summary.completedAt=new Date().toISOString();await writeFile(summaryFile,JSON.stringify(summary,null,2));
  const unresolved=[...new Set(summary.months.flatMap(m=>(m.warnings as string[])||[]))];
  if(apply)await db.update(crawlJobsTable).set({status:summary.failures||unresolved.length?'error':'done',progress:100,currentSource:'',collected:summary.inserted,duplicates:summary.duplicates,total:summary.inserted+summary.duplicates,error:`${start}~${end} 월별 과거 누락 점검. 신규 ${summary.inserted}, 중복 ${summary.duplicates}, 저장 실패 ${summary.failures}. 수집 범위: ${unresolved.length?"일부 미확인":"조회 완료"}. ${unresolved.join("; ")} 상세 대조 결과: ${output}`}).where(eq(crawlJobsTable.id,jobId));
 });
}catch(error){
 if(apply)await db.update(crawlJobsTable).set({status:'error',error:String(error)}).where(eq(crawlJobsTable.id,jobId)).catch(()=>{});
 throw error;
}finally{await pool.end();}

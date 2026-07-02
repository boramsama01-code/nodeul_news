import axios from "axios";
import * as cheerio from "cheerio";
const log=(...a)=>console.log(...a);
const EXCLUDE=["노들장애인야학","노들강변"];
const isRel=(t,c)=>{const x=t+" "+c;return x.includes("노들")&&!EXCLUDE.some(e=>x.includes(e));};
const isUrl=u=>{try{const x=new URL(u);return["http:","https:"].includes(x.protocol);}catch{return false;}};
function parseDate(text){
  const m=text.match(/(\d{4})\.(\d{2})\.(\d{2})/); if(m)return `${m[1]}-${m[2]}-${m[3]}`;
  const now=new Date();
  const h=text.match(/(\d+)시간 전/); if(h)return new Date(now-h[1]*3600000).toISOString().slice(0,10);
  const d=text.match(/(\d+)일 전/); if(d)return new Date(now-d[1]*86400000).toISOString().slice(0,10);
  if(/\d+분 전|방금/.test(text)||text.includes("오늘"))return now.toISOString().slice(0,10);
  if(text.includes("어제"))return new Date(now-86400000).toISOString().slice(0,10);
  return "";
}
async function month(sd,ed,label){
  const start=new Date(sd+"T00:00:00+09:00"), end=new Date(ed+"T23:59:59+09:00");
  const ds=sd.replace(/-/g,"."), de=ed.replace(/-/g,".");
  const seenAll=new Set();
  const seenKept=new Set();
  let pages=0, lastStart=0, endReason="";
  for(let st=1; st<=1000; st+=10){
    lastStart=st;
    const r=await axios.get("https://search.naver.com/search.naver",{
      params:{where:"news",query:"노들",sort:1,pd:3,ds,de,start:st},
      headers:{"User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36","Accept-Language":"ko-KR,ko;q=0.9","Referer":"https://www.naver.com/"},timeout:15000}).catch(()=>null);
    if(!r){ endReason="요청실패/타임아웃"; break; }
    const html=r.data; const $=cheerio.load(html);
    const aTags=$('a[data-heatmap-target=".tit"]');
    if(aTags.length===0){ endReason="결과없음"; break; }
    pages++;
    let from=0, newOnPage=0;
    aTags.each((_,el)=>{
      const a=$(el); const raw=a.attr("href")??""; const url=raw.replace(/&amp;/g,"&"); const title=a.text().trim();
      if(!url||!title||!isUrl(url)) return;
      if(seenAll.has(url)) return; seenAll.add(url); newOnPage++;
      const snip=raw.slice(0,60); let pos=html.indexOf(snip,from); if(pos<0)pos=html.indexOf(snip); from=pos+1;
      const dateStr=parseDate(html.slice(Math.max(0,pos-2000),pos+500));
      if(!dateStr) return;
      const summary=$('a[data-heatmap-target=".body"]').filter((_,e2)=>{const h=$(e2).attr("href")??"";return h===raw||h.replace(/&amp;/g,"&")===url;}).text().trim();
      if(!isRel(title,summary)) return;
      const pd=new Date(dateStr+"T12:00:00+09:00");
      if(pd<start||pd>end) return;
      seenKept.add(url);
    });
    if(newOnPage===0){ endReason="신규없음(상한/중복)"; break; }
    await new Promise(r=>setTimeout(r,300));
  }
  log(`  [${label}] 페이지 ${pages}, 고유기사 ${seenAll.size}, 최종수집 ${seenKept.size} (마지막start=${lastStart}, 종료=${endReason})`);
  return seenKept.size;
}
const months=[
  ["2026-01-01","2026-01-31","1월"],["2026-02-01","2026-02-28","2월"],
  ["2026-03-01","2026-03-31","3월"],["2026-04-01","2026-04-30","4월"],
  ["2026-05-01","2026-05-31","5월"],["2026-06-01","2026-06-05","6월"],
];
let total=0;
for(const [s,e,l] of months){ total += await month(s,e,l); }
log(`\n==> 네이버 웹 1/1~6/5 최종 수집 합계: ${total}건`);

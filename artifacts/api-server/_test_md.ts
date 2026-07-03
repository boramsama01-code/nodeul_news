
import { crawlNaverWebSearch, crawlDaumNews, crawlAllSources } from "./src/lib/crawlerSources";
import { extractPressName, isRelevant, isValidUrl } from "./src/lib/crawlerUtils";

(async () => {
  const nw = await crawlNaverWebSearch("2026-01-01", "2026-01-31");
  const dm = await crawlDaumNews("2026-01-01", "2026-01-31");
  const rss = await crawlAllSources("2026-01-01", "2026-01-31");
  const gnews = rss.filter(r => r.source === "google_news_rss");
  const articles = [...nw, ...dm, ...gnews];
  console.log("포털 수집:", "naver_web", nw.length, "| daum_web", dm.length, "| google_news_rss", gnews.length, "| 합계", articles.length);

  // media_direct 시뮬레이션
  const mdPriority = { naver_web: 0, daum_web: 1, google_news_rss: 2 };
  const sorted = [...articles].sort((a,b) => (mdPriority[a.source]??9) - (mdPriority[b.source]??9));
  const set = new Set();
  const md = [];
  for (const a of sorted) {
    if (!isRelevant(a.title, a.content)) continue;
    if (!isValidUrl(a.url)) continue;
    const press = extractPressName(a.mediaName);
    const fp = a.title + "__" + press;
    if (set.has(fp)) continue;
    set.add(fp);
    md.push({ press, title: a.title.slice(0,25), src: a.source });
  }
  console.log("media_direct 생성:", md.length, "건");
  console.log("--- 언론사별 media_direct 분포(상위 15) ---");
  const dist = {};
  md.forEach(m => dist[m.press] = (dist[m.press]||0)+1);
  Object.entries(dist).sort((a,b)=>b[1]-a[1]).slice(0,15).forEach(([p,c]) => console.log(c, p));
  console.log("--- 샘플 5건 (대표URL source 확인) ---");
  md.slice(0,5).forEach(m => console.log(m.press, "|", m.src, "|", m.title));
  process.exit(0);
})();


import { crawlNaverWebSearch, crawlAllSources } from "./src/lib/crawlerSources";

function dist(results, label) {
  console.log("=== " + label + ": " + results.length + "건 ===");
  const formats = {};
  results.forEach(r => {
    const key = r.mediaName.replace(/\(.*\)/, "(...)");
    formats[key] = (formats[key] || 0) + 1;
  });
  console.log("패턴:", JSON.stringify(formats));
  results.slice(0, 5).forEach(r =>
    console.log("  ", r.mediaName, "| src:", r.source, "|", r.title.slice(0, 22))
  );
  // 기타 비율
  const etc = results.filter(r => r.mediaName.includes("(기타)")).length;
  console.log("  기타:", etc, "/", results.length);
}

(async () => {
  const nw = await crawlNaverWebSearch("2026-01-01", "2026-01-31");
  dist(nw, "naver_web");
  const rss = await crawlAllSources("2026-01-01", "2026-01-31");
  const gnews = rss.filter(r => r.source === "google_news_rss");
  const rssDirect = rss.filter(r => r.source === "rss_direct");
  dist(gnews, "google_news_rss");
  dist(rssDirect, "rss_direct");
})();


import { crawlNaverWebSearch } from "./src/lib/crawlerSources";

function dist(results, label) {
  console.log("=== " + label + ": " + results.length + "건 ===");
  const formats = {};
  results.forEach(r => {
    const key = r.mediaName.replace(/\(.*\)/, "(...)");
    formats[key] = (formats[key] || 0) + 1;
  });
  console.log("패턴:", JSON.stringify(formats));
  results.slice(0, 6).forEach(r =>
    console.log("  ", r.mediaName, "|", r.title.slice(0, 22))
  );
  const etc = results.filter(r => r.mediaName.includes("(기타)")).length;
  console.log("  기타:", etc, "/", results.length);
}

(async () => {
  console.log("naver_web 크롤 시작...");
  const nw = await crawlNaverWebSearch("2026-01-01", "2026-01-31");
  dist(nw, "naver_web");
  process.exit(0);
})();

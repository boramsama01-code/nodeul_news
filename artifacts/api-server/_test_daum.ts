
import { crawlDaumNews } from "./src/lib/crawlerSources";

(async () => {
  const results = await crawlDaumNews("2026-01-01", "2026-01-31");
  console.log("daum_web 수집:", results.length, "건");
  results.slice(0, 8).forEach(r =>
    console.log(" mediaName:", r.mediaName, "| src:", r.source, "|", r.title.slice(0, 25))
  );
  // mediaName 형식 검증
  const formats = {};
  results.forEach(r => {
    const key = r.mediaName.replace(/\(.*\)/, "(...)");
    formats[key] = (formats[key] || 0) + 1;
  });
  console.log("--- mediaName 패턴 분포:", JSON.stringify(formats));
})();

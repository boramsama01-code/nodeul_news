
import { crawlNaverWebSearch } from "./src/lib/crawlerSources";
(async () => {
  const r = await crawlNaverWebSearch("2026-05-01", "2026-05-31");
  console.log("5월 단독(최초 실행) naver_web:", r.length, "건");
  process.exit(0);
})();

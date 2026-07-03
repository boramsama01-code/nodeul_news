
import { crawlNaverWebSearch } from "./src/lib/crawlerSources";

(async () => {
  for (const [s, e, label] of [["2026-03-01","2026-03-31","3월"],["2026-04-01","2026-04-30","4월"],["2026-05-01","2026-05-31","5월"]]) {
    try {
      const r = await crawlNaverWebSearch(s, e);
      console.log(label, "naver_web:", r.length, "건");
    } catch (err) {
      console.log(label, "에러:", err.message);
    }
  }
  process.exit(0);
})();

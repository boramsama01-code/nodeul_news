
import { crawlNaverWebSearch } from "./src/lib/crawlerSources";
(async () => {
  const months = [["2026-03-01","2026-03-31","3월"],["2026-04-01","2026-04-30","4월"],["2026-05-01","2026-05-31","5월"]];
  for (let i = 0; i < months.length; i++) {
    const [s, e, label] = months[i];
    const r = await crawlNaverWebSearch(s, e);
    console.log(label, "naver_web:", r.length, "건");
    if (i < months.length - 1) await new Promise(x => setTimeout(x, 5000));
  }
  process.exit(0);
})();

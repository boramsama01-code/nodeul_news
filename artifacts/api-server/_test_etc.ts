
import { crawlNaverWebSearch } from "./src/lib/crawlerSources";
import { resolveMediaNameStrict } from "./src/lib/crawlerUtils";

(async () => {
  const nw = await crawlNaverWebSearch("2026-01-01", "2026-01-31");
  const etcDomains = {};
  nw.forEach(r => {
    if (r.mediaName.includes("(기타)")) {
      try {
        const d = new URL(r.url).hostname.replace(/^www\./, "");
        etcDomains[d] = (etcDomains[d] || 0) + 1;
      } catch {}
    }
  });
  const sorted = Object.entries(etcDomains).sort((a,b) => b[1]-a[1]);
  console.log("=== 기타로 빠진 도메인 (상위 25) ===");
  sorted.slice(0, 25).forEach(([d, c]) => console.log(c, d));
  console.log("--- 고유 도메인 수:", sorted.length);
  process.exit(0);
})();

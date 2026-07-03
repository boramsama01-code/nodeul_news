
import { crawlNaverNews } from "./src/lib/crawlerSources";

(async () => {
  const start = "2026-01-01";
  const end = "2026-01-31";
  console.log("naver_api 테스트:", start, "~", end);
  console.log("CLIENT_ID 존재:", !!process.env.NAVER_CLIENT_ID);
  try {
    const results = await crawlNaverNews(start, end);
    console.log("수집 건수:", results.length);
    results.slice(0, 3).forEach(r =>
      console.log(" -", r.mediaName, "|", r.url.slice(0, 55), "|", r.title.slice(0, 35))
    );
  } catch (e) {
    console.error("에러:", e.message);
    console.error(e.stack);
  }
})();

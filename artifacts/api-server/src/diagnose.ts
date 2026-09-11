import { crawlAllSources, crawlSource, crawlDaumNews, crawlNaverNews, crawlNaverWebSearch } from "./lib/crawlerSources";
import { NEWS_SOURCES } from "./lib/rssFeedList";
import { crawlWarnings, kstDate, shiftDate, validateDateRange } from "./lib/crawlRuntime";

const args = process.argv.slice(2).filter(x => x !== "--all");
const end = args[1] || kstDate();
const start = args[0] || shiftDate(end, -3);
validateDateRange(start, end);
const warnings: string[] = [];
await crawlWarnings.run(warnings, async () => {
  const sources = [
    { name: "네이버 API", run: () => crawlNaverNews(start, end) },
    { name: "네이버 웹", run: () => crawlNaverWebSearch(start, end) },
    { name: "다음", run: () => crawlDaumNews(start, end) },
    ...(process.argv.includes("--all")
      ? [{ name: "전체 RSS", run: () => crawlAllSources(start, end) }]
      : NEWS_SOURCES.slice(0, 6).map(source => ({name: source.name, run: () => crawlSource(source, start, end)}))),
  ];
  const results = await Promise.all(sources.map(async source => {
    try {
      const articles = await source.run();
      return { source: source.name, accepted: articles.length, uniqueUrls: new Set(articles.map(a => a.url)).size };
    } catch (err) { return { source: source.name, error: String(err) }; }
  }));
  console.log(JSON.stringify({ start, end, note: "DB 저장 전 후보 기사 수; 기존 기사와 중복일 수 있습니다.", results, warnings }, null, 2));
});

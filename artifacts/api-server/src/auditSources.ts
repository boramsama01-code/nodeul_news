import fs from "node:fs/promises";
import path from "node:path";
import { NEWS_SOURCES } from "./lib/rssFeedList";
import { coverageForRange, loadOfficialFeed } from "./lib/sourceFeeds";

const args = process.argv.slice(2);
const arg = (name: string, fallback: string) => args.find(v => v.startsWith(`${name}=`))?.slice(name.length + 1) || fallback;
const outputIndex = args.indexOf("--output");
const outputFile = outputIndex >= 0 ? path.resolve(args[outputIndex + 1]!) : undefined;
const outputDir = outputFile ? path.dirname(outputFile) : path.resolve(arg("--output", "reports"));
const basename = arg("--name", "source-audit");
const startDate = arg("--start", "2025-01-01");
const endDate = arg("--end", "2025-01-14");
const discovery = !args.includes("--direct-only");
const concurrency = Math.max(1, Math.min(4, Number(arg("--concurrency", "4")) || 4));
const chosen = arg("--source", "");
const direct = NEWS_SOURCES.filter(s => s.method === "rss_direct" && (!chosen || s.name.includes(chosen)));
const results = new Array<Record<string, unknown>>(direct.length);
let next = 0;
await Promise.all(Array.from({ length: Math.min(concurrency, direct.length) }, async () => {
  while (next < direct.length) {
    const index = next++;
    const source = direct[index]!;
    const result = await loadOfficialFeed(source, { discovery });
    const keywordItems = result.feed.items.filter(i => /노들/.test(`${i.title || ""} ${i.contentSnippet || i.content || ""}`));
    results[index] = {
      name: source.name, domain: source.domain, method: source.method, configuredUrl: source.url,
      ...result, feed: undefined, itemCount: result.feed.items.length,
      coverage: coverageForRange(result, startDate, endDate),
      keyword: "노들", keywordCount: keywordItems.length,
      keywordExamples: keywordItems.slice(0, 3).map(i => ({ title: i.title, url: i.link, publishedAt: i.pubDate || i.isoDate })),
    };
    console.log(`[${index + 1}/${direct.length}] ${source.name}: ${result.status} (${result.feed.items.length}) ${result.reason}`);
  }
}));
const portals = chosen ? [] : NEWS_SOURCES.filter(s => s.method === "google_news_rss").map(s => ({
  name: s.name, domain: s.domain, method: s.method, configuredUrl: s.url, status: "partial", reason: "포털 검색만 설정됨 · 공식 원문 피드는 미확인", checked: false,
}));
const totals = { directEndpoints: results.length, normal: results.filter(r => r.status === "normal").length,
  partial: results.filter(r => r.status === "partial").length, unsupported: results.filter(r => r.status === "unsupported").length,
  outsideRange: results.filter(r => r.coverage === "outside_range").length, portalOnlyConfigured: portals.length };
const report = { checkedAt: new Date().toISOString(), startDate, endDate, discovery, totals, sources: [...results, ...portals],
  limitations: ["RSS/Atom and news sitemaps are rolling recent feeds, not complete historical archives.",
    "Unsupported means no usable official feed found within this bounded check; it does not mean articles do not exist.",
    "Portal-only rows describe existing configuration, not live verification of each Google query.",
    "Discovery follows publisher-advertised RSS/Atom and robots.txt Sitemap links; at most 8 document requests per source, 4 concurrent sources, 3 MiB per response, 12 seconds per redirect chain.",
    "Generic sitemaps without a news title and publication date are recorded but do not trigger article-wide crawling."], results, portalOnlySources: portals };
await fs.mkdir(outputDir, { recursive: true });
await fs.writeFile(outputFile || path.join(outputDir, `${basename}.json`), JSON.stringify(report, null, 2), "utf8");
const label: Record<string, string> = { normal: "정상", partial: "부분지원", unsupported: "미지원/확인실패" };
const table = results.map(r => `| ${r.name} | ${label[String(r.status)]} | ${r.itemCount} | ${r.coverage} | ${r.reason} | [설정](${r.configuredUrl})${r.endpoint && r.endpoint !== r.configuredUrl ? ` · [실제](${r.endpoint})` : ""} |`).join("\n");
const md = `# 언론사 공식 피드 점검\n\n점검: ${report.checkedAt}. 비교 기간: ${startDate} ~ ${endDate}.\n\n직접 피드 ${totals.directEndpoints}개: 정상 ${totals.normal}, 부분지원 ${totals.partial}, 미지원/확인실패 ${totals.unsupported}. 이 중 ${totals.outsideRange}개는 제공 날짜가 요청 기간과 겹치지 않습니다.\n\n'미지원/확인실패'는 제한된 요청 안에서 수집 가능한 공식 피드를 찾지 못했다는 뜻이며, 원문 기사 부재를 뜻하지 않습니다. RSS와 뉴스 사이트맵은 최근 기사 목록이므로 과거 전체 검색을 보장하지 않습니다. 일반 사이트맵의 lastmod는 발행일로 사용하지 않습니다.\n\n| 언론사 | 상태 | 기사 수 | 기간 | 근거 | URL |\n|---|---|---:|---|---|---|\n${table}\n\n## 포털 검색만 설정된 소스\n\n${portals.length}개. 아래 항목은 직접 RSS가 아닌 Google 검색 보완 설정입니다. 개별 쿼리를 이 감사에서 실시간 검증한 것은 아닙니다.\n\n${portals.map(p => `- ${p.name}: ${p.domain}`).join("\n")}\n\n각 HTTP 상태·오류·발견 URL은 같은 이름의 JSON 보고서 attempts에 기록했습니다.\n`;
await fs.writeFile(path.join(outputDir, `${basename}.md`), md, "utf8");
console.log(JSON.stringify(totals));

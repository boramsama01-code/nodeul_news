
import { resolveMediaName, resolveMediaNameStrict } from "./src/lib/crawlerUtils";

const tests = [
  "https://sports.khan.co.kr/article/123",
  "https://enter.etoday.co.kr/view/1",
  "https://news.jtbc.co.kr/article/1",
  "https://view.asiae.co.kr/article/1",
  "https://www.khan.co.kr/article/1",
  "https://www.stardailynews.co.kr/news/1"
];
tests.forEach(u => {
  const domain = new URL(u).hostname.replace(/^www\./, "");
  const rmn = resolveMediaName(u, "");
  const rms = resolveMediaNameStrict(u);
  console.log(domain, "| resolveMediaName:", JSON.stringify(rmn), "| strict:", JSON.stringify(rms));
});
process.exit(0);

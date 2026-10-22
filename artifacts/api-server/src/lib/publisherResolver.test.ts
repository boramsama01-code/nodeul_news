import test from "node:test";
import assert from "node:assert/strict";

process.env.DATABASE_URL ||= "postgresql://localhost/test";

const resolver = () => import("./publisherResolver");

test("extractPublisherFromHtml reads JSON-LD publisher", async () => {
  const { extractPublisherFromHtml } = await resolver();
  const result = extractPublisherFromHtml(`<!doctype html><html><head>
    <script type="application/ld+json">{"@type":"NewsArticle","publisher":{"@type":"Organization","name":"테스트일보"}}</script>
  </head></html>`, "https://unknown.example/article/1");
  assert.equal(result.publisher, "테스트일보");
  assert.equal(result.evidence, "json-ld");
});

test("extractPublisherFromHtml prefers known canonical domain", async () => {
  const { extractPublisherFromHtml } = await resolver();
  const result = extractPublisherFromHtml(
    '<link rel="canonical" href="https://www.yna.co.kr/view/AKR1">',
    "https://v.daum.net/v/1",
  );
  assert.equal(result.publisher, "연합뉴스");
  assert.equal(result.evidence, "domain");
});

test("unknown labels are replaced while preserving portal prefix", async () => {
  const { formatResolvedMediaName, isUnknownPublisher } = await resolver();
  assert.equal(formatResolvedMediaName("네이버(기타)", "서울신문"), "네이버(서울신문)");
  assert.equal(formatResolvedMediaName("다음뉴스", "뉴시스"), "다음뉴스(뉴시스)");
  assert.equal(isUnknownPublisher("구글뉴스(기타)"), true);
  assert.equal(isUnknownPublisher("구글뉴스(연합뉴스)"), false);
});

import test from "node:test";
import assert from "node:assert/strict";
import { discoverFeedUrlsFromHtml, parseOfficialFeedText, sanitizeXml } from "./rssTransport";
import { loadOfficialFeed } from "./sourceFeeds";

test("official collection preserves the coverage wrapper when repairing RSS without extra requests", async () => {
  let requests = 0;
  const result = await loadOfficialFeed({ name: "테스트", domain: "press.example", url: "https://press.example/rss", method: "rss_direct" }, {
    fetch: async url => {
      requests++;
      return { url, status: 200, body: '<rss version="2.0"><channel><title>언론사</title><item><title>노들섬 A & B</title><link>https://press.example/a</link><pubDate>Wed, 21 Oct 2026 12:00:00 +0900</pubDate></item></channel></rss>' };
    },
  });
  assert.equal(result.feed.items[0]?.title, "노들섬 A & B");
  assert.equal(result.status, "partial");
  assert.equal(result.reason, "recovered_official_feed");
  assert.equal(requests, 1);
});

test("sanitizeXml removes control bytes and escapes bare ampersands", () => {
  assert.equal(
    sanitizeXml("\uFEFF<rss>\u0001<title>A & B &amp; C</title></rss>"),
    "<rss><title>A &amp; B &amp; C</title></rss>",
  );
});

test("parseOfficialFeedText repairs a bare ampersand", async () => {
  const parsed = await parseOfficialFeedText(`<?xml version="1.0"?><rss version="2.0"><channel>
    <title>테스트</title><item><title>A & B</title><link>https://example.com/a</link>
    <pubDate>Wed, 21 Oct 2026 12:00:00 +0900</pubDate></item></channel></rss>`);
  assert.equal(parsed.parseMode, "sanitized-xml");
  assert.equal(parsed.feed.items?.[0]?.title, "A & B");
});

test("parseOfficialFeedText tolerates malformed close tags", async () => {
  const parsed = await parseOfficialFeedText(`<rss><channel><title>테스트</title>
    <item><title>기사</title><link>https://example.com/a</link><description>요약</description></wrong>
    </channel></rss>`);
  assert.equal(parsed.parseMode, "tolerant-xml");
  assert.equal(parsed.feed.items?.[0]?.title, "기사");
});

test("discoverFeedUrlsFromHtml finds same-publication RSS and rejects unrelated links", () => {
  const urls = discoverFeedUrlsFromHtml(`<!doctype html><html><head>
    <link rel="alternate" type="application/rss+xml" href="/rss/news.xml">
    <link rel="alternate" type="application/rss+xml" href="https://evil.example/rss.xml">
    </head><body><a href="https://news.example.co.kr/feed">RSS</a></body></html>`,
    "https://www.example.co.kr/");
  assert.deepEqual(urls, [
    "https://www.example.co.kr/rss/news.xml",
    "https://news.example.co.kr/feed",
  ]);
});

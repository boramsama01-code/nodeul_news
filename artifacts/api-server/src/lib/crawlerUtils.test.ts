import test from "node:test";
import assert from "node:assert/strict";
import { addToSet, isDuplicate } from "./crawlerUtils";

const publishedAt = new Date("2026-09-04T01:50:27.000Z");

test("Google News treats identical headlines from different presses as distinct", () => {
  const existing = new Set<string>();
  addToSet(
    "https://news.google.com/rss/articles/press-a",
    "같은 제목",
    publishedAt,
    existing,
    "google_news_rss",
    "구글뉴스(언론사A)",
  );

  assert.equal(
    isDuplicate(
      "https://news.google.com/rss/articles/shared",
      "같은 제목",
      publishedAt,
      existing,
      "google_news_rss",
      "구글뉴스(언론사B)",
    ),
    false,
  );
});

test("Google News preserves different URLs even with the same press and headline", () => {
  const existing = new Set<string>();
  addToSet(
    "https://news.google.com/rss/articles/press-b",
    "같은 제목",
    publishedAt,
    existing,
    "google_news_rss",
    "구글뉴스(언론사A)",
  );

  assert.equal(
    isDuplicate(
      "https://news.google.com/rss/articles/press-a-other-token",
      "같은 제목",
      publishedAt,
      existing,
      "google_news_rss",
      "구글뉴스(언론사A)",
    ),
    false,
  );
});

test("non-Google sources also preserve distinct publishers", () => {
  const existing = new Set<string>();
  addToSet(
    "https://example.com/article",
    "같은 제목",
    publishedAt,
    existing,
    "daum_web",
    "다음뉴스(언론사A)",
  );

  assert.equal(
    isDuplicate(
      "https://example.com/different-url",
      "같은 제목",
      publishedAt,
      existing,
      "daum_web",
      "다음뉴스(언론사B)",
    ),
    false,
  );
});
test('only identical source and literal URL deduplicate',()=>{const set=new Set<string>();const url='http://www.paper.example/a?ref=x#section';addToSet(url,'title',publishedAt,set,'daum_web');assert.equal(isDuplicate(url,'changed',publishedAt,set,'daum_web'),true);for(const variant of ['https://www.paper.example/a?ref=x#section','http://www.paper.example/a?ref=y#section','http://www.paper.example/a?ref=x'])assert.equal(isDuplicate(variant,'title',publishedAt,set,'daum_web'),false);assert.equal(isDuplicate(url,'title',publishedAt,set,'naver_web'),false);});

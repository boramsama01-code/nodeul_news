import test from "node:test";
import assert from "node:assert/strict";
import { addToSet, isDuplicate } from "./crawlerUtils";

const publishedAt = new Date("2026-09-04T01:50:27.000Z");

test("Google News treats identical headlines from different presses as distinct", () => {
  const existing = new Set<string>();
  addToSet(
    "https://news.google.com/rss/articles/shared",
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

test("Google News still deduplicates the same press and headline", () => {
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
      "https://news.google.com/rss/articles/press-a-other-token",
      "같은 제목",
      publishedAt,
      existing,
      "google_news_rss",
      "구글뉴스(언론사A)",
    ),
    true,
  );
});

test("non-Google sources keep source and headline/date deduplication", () => {
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
    true,
  );
});
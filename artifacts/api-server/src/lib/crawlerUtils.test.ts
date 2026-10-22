import test from "node:test";
import assert from "node:assert/strict";
import { addToSet, isDuplicate, isRelevant } from "./crawlerUtils";

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
      "https://news.google.com/rss/articles/other-press",
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

test("non-Google sources retain the same headline from different publishers", () => {
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

test("same URL remains distinct across every collection route", () => {
  const existing = new Set<string>();
  for (const source of ["naver_api", "naver_web", "daum_web", "google_news_rss", "rss_direct"]) {
    assert.equal(isDuplicate("https://example.com/a", "노들섬 행사", publishedAt, existing, source, "언론사A"), false);
    addToSet("https://example.com/a", "노들섬 행사", publishedAt, existing, source, "언론사A");
    assert.equal(isDuplicate("https://example.com/a", "노들섬 행사", publishedAt, existing, source, "언론사A"), true);
  }
});

test("unknown publisher never causes headline-only deduplication", () => {
  const existing = new Set<string>();
  addToSet("https://example.com/ABC", "노들섬 행사", publishedAt, existing, "naver_api", "네이버뉴스");
  assert.equal(isDuplicate("https://example.com/abc", "노들섬 행사", publishedAt, existing, "naver_api", "네이버뉴스"), false);
  assert.equal(isDuplicate("https://example.org/new", "노들섬 행사", publishedAt, existing, "naver_api", "네이버뉴스"), false);
});

test("known publisher duplicates use the same Korean calendar day", () => {
  const existing = new Set<string>();
  addToSet("https://example.com/a", "노들섬 행사", new Date("2026-01-01T16:00:00Z"), existing, "rss_direct", "언론사A");
  assert.equal(isDuplicate("https://example.com/b", "노들섬 행사", new Date("2026-01-02T01:00:00Z"), existing, "rss_direct", "언론사A"), true);
});

test("only the approved phrases qualify, allowing whitespace variants", () => {
  for (const text of ["노들섬 행사", "예술섬노들", "예술섬 노들", "글로벌 노들 예술섬", "노들 글로벌 예술섬", "글로벌\n노들\u00a0예술섬", "노들길을 지나 노들섬 도착", "노들장애인야학과 노들섬 소식"]) {
    assert.equal(isRelevant(text, ""), true, text);
    assert.equal(isRelevant("행사 안내", text), true, text);
  }
  for (const text of ["노들길 교통통제", "노들로", "노들", "노들강변", "노들장애인야학"]) {
    assert.equal(isRelevant(text, "소식"), false, text);
  }
  assert.equal(isRelevant("예술섬", "노들"), false);
});

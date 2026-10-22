import test from "node:test";
import assert from "node:assert/strict";
import { PgDialect } from "drizzle-orm/pg-core";
import type { ArticleData } from "./crawlerUtils";

process.env.DATABASE_URL ??= "postgres://localhost/test";

for (const mode of ["normal", "bulk"] as const) {
  test(`${mode} crawl refreshes excluded summaries, preserves annotations/trash, and ignores excluded headline fingerprints`, async () => {
    const { articlesTable } = await import("@workspace/db");
    const { runCrawlJob } = await import("./crawlOrchestrator");
    const { runBulkCrawlJob } = await import("./bulkCrawlOrchestrator");
    const publishedAt = new Date("2026-01-15T03:00:00Z");
    const row = (id: number, title: string, deletedAt: Date | null = null) => ({
      id, title, content: "노들길 소식", url: `https://example.com/${id}`, publishedAt,
      mediaName: "언론사A", source: "naver_web", isNegative: true, isSelfPR: true, deletedAt,
    });
    const oldRows = [row(1, "행사 안내"), row(2, "교통 안내", new Date("2026-01-16T00:00:00Z")), row(3, "새 소식")];
    const incoming = (old: (typeof oldRows)[number], url = old.url): ArticleData => ({
      title: old.title, content: "노들섬 행사 안내", url, publishedAt, mediaName: old.mediaName,
      source: old.source, isNegative: false, isSelfPR: false,
    });
    const articles = [incoming(oldRows[2]!, "https://example.com/new"), incoming(oldRows[0]!), incoming(oldRows[0]!), incoming(oldRows[1]!)];
    const inserted: ArticleData[] = [];
    const articleUpdates: Record<string, unknown>[] = [];
    const jobUpdates: Record<string, unknown>[] = [];
    let reads = 0;
    const fakeDb = {
      select: () => ({ from: async () => { reads++; return oldRows; } }),
      insert: () => ({ values: async (value: ArticleData) => { inserted.push(value); } }),
      update: (table: unknown) => ({ set: (value: Record<string, unknown>) => {
        if (table !== articlesTable) {
          jobUpdates.push(value);
          return { where: async () => undefined };
        }
        articleUpdates.push(value);
        return { where: (condition: Parameters<PgDialect["sqlToQuery"]>[0]) => ({ returning: async () => {
          const query = new PgDialect().sqlToQuery(condition);
          assert.match(query.sql, /"deleted_at" is null/);
          assert.deepEqual(query.params, [1]);
          Object.assign(oldRows[0]!, value);
          return [{ id: 1 }];
        } }) };
      } }),
    };
    const dependencies = {
      db: fakeDb as never,
      analyzeArticleSentiment: async () => false,
      crawlNaverNews: async () => [],
      crawlNaverWebSearch: async () => articles,
      crawlDaumNews: async () => [],
      crawlAllSources: async () => [],
    };
    await (mode === "normal" ? runCrawlJob : runBulkCrawlJob)("refresh-test", "2026-01-01", "2026-01-31", dependencies);
    assert.equal(reads, 1, "duplicates do not trigger additional reads");
    assert.equal(articleUpdates.length, 1, "only an existing excluded, non-trash row is refreshed");
    assert.deepEqual(Object.keys(articleUpdates[0]!).sort(), ["content", "mediaName", "publishedAt", "title"]);
    assert.equal(oldRows[0]!.isNegative, true);
    assert.equal(oldRows[0]!.isSelfPR, true);
    assert.equal(oldRows[1]!.content, "노들길 소식");
    assert.ok(oldRows[1]!.deletedAt);
    assert.deepEqual(inserted.map(article => article.url), ["https://example.com/new"]);
    assert.equal(jobUpdates.at(-1)?.collected, 1);
    assert.equal(jobUpdates.at(-1)?.duplicates, 2);
    assert.match(String(jobUpdates.at(-1)?.error), /기존 기사 내용 갱신 1/);
    assert.equal(jobUpdates.at(-1)?.status, "done");
  });
}

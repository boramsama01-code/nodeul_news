import { test } from "node:test";
import assert from "node:assert/strict";
import type { ArticleData } from "./crawlerUtils";
import type { CrawlJobDependencies } from "./crawlOrchestrator";
import type { BulkCrawlJobDependencies } from "./bulkCrawlOrchestrator";

process.env.DATABASE_URL ??= "postgres://localhost:5432/news-monitor-test";

type InsertedArticle = {
  title: string;
  content: string;
  url: string;
  publishedAt: Date;
  mediaName: string;
  isNegative: boolean;
  isSelfPR: boolean;
  source: string;
};

function createFakeDb(inserted: InsertedArticle[]) {
  return {
    select: () => ({
      from: async () => [],
    }),
    update: () => ({
      set: () => ({
        where: async () => undefined,
      }),
    }),
    insert: () => ({
      values: async (value: InsertedArticle) => {
        inserted.push(value);
      },
    }),
  };
}

function asArticle(
  title: string,
  content: string,
  source: string,
  mediaName = "테스트언론사",
): ArticleData {
  return {
    title,
    content,
    url: `https://example.com/${encodeURIComponent(title)}`,
    publishedAt: new Date("2026-01-15T00:00:00.000Z"),
    mediaName,
    isNegative: false,
    isSelfPR: false,
    source,
  };
}

async function withAnthropicFailure<T>(callback: () => Promise<T>): Promise<T> {
  const previousKey = process.env.ANTHROPIC_API_KEY;
  const previousFetch = globalThis.fetch;
  process.env.ANTHROPIC_API_KEY = "test-anthropic-key";
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        type: "error",
        error: { type: "authentication_error", message: "simulated Anthropic API failure" },
      }),
      { status: 401, headers: { "content-type": "application/json" } },
    );

  try {
    return await callback();
  } finally {
    if (previousKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = previousKey;
    globalThis.fetch = previousFetch;
  }
}

test("ANTHROPIC_API_KEY가 없으면 부정 키워드만 규칙 기반으로 판정한다", async () => {
  const previousKey = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;

  try {
    const { analyzeArticleSentiment, hasAiKey } = await import("./aiAnalysis");

    assert.equal(hasAiKey(), false);
    assert.equal(
      await analyzeArticleSentiment(
        "노들섬 운영 논란",
        "주민들은 노들섬 운영 문제에 대해 강하게 비판했다.",
      ),
      true,
    );
    assert.equal(
      await analyzeArticleSentiment(
        "노들섬 봄꽃 행사 개최",
        "노들섬에서 시민을 위한 봄꽃 행사가 열렸다.",
      ),
      false,
    );
  } finally {
    if (previousKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = previousKey;
  }
});

test("Anthropic 호출 실패 시 키가 있어도 부정 키워드와 일반 기사를 구분한다", async () => {
  await withAnthropicFailure(async () => {
    const { analyzeArticleSentiment, hasAiKey } = await import("./aiAnalysis");

    assert.equal(hasAiKey(), true);
    assert.equal(
      await analyzeArticleSentiment(
        "노들섬 운영 논란",
        "주민들은 노들섬 운영 문제에 대해 강하게 비판했다.",
      ),
      true,
    );
    assert.equal(
      await analyzeArticleSentiment(
        "노들섬 봄꽃 행사 개최",
        "노들섬에서 시민을 위한 봄꽃 행사가 열렸다.",
      ),
      false,
    );
  });
});

test("AI 분석 실패에도 일반 크롤링 저장이 중단되지 않는다", async () => {
  await withAnthropicFailure(async () => {
    const inserted: InsertedArticle[] = [];
    const negative = asArticle(
      "노들섬 운영 논란",
      "노들섬 운영에 대한 주민 비판이 이어졌다.",
      "naver_api",
    );
    const ordinary = asArticle(
      "노들섬 봄꽃 행사 개최",
      "노들섬에서 시민을 위한 행사가 열렸다.",
      "naver_api",
    );
    const { analyzeArticleSentiment } = await import("./aiAnalysis");
    const { runCrawlJob } = await import("./crawlOrchestrator");

    await runCrawlJob("crawl-test", "2026-01-01", "2026-01-31", {
      db: createFakeDb(inserted) as unknown as CrawlJobDependencies["db"],
      analyzeArticleSentiment,
      crawlNaverNews: async () => [negative, ordinary],
      crawlNaverWebSearch: async () => [],
      crawlDaumNews: async () => [],
      crawlAllSources: async () => [],
    });

    assert.deepEqual(
      inserted.map(({ title, isNegative }) => ({ title, isNegative })),
      [
        { title: negative.title, isNegative: true },
        { title: ordinary.title, isNegative: false },
      ],
    );
  });
});

test("AI 분석 실패에도 대량 크롤링 저장이 중단되지 않는다", async () => {
  await withAnthropicFailure(async () => {
    const inserted: InsertedArticle[] = [];
    const negative = asArticle(
      "노들섬 운영 논란",
      "노들섬 운영에 대한 주민 비판이 이어졌다.",
      "naver_web",
      "네이버(조선일보)",
    );
    const ordinary = asArticle(
      "노들섬 봄꽃 행사 개최",
      "노들섬에서 시민을 위한 행사가 열렸다.",
      "naver_web",
      "네이버(한겨레)",
    );
    const { analyzeArticleSentiment } = await import("./aiAnalysis");
    const { runBulkCrawlJob } = await import("./bulkCrawlOrchestrator");

    await runBulkCrawlJob("bulk-test", "2026-01-01", "2026-01-31", {
      db: createFakeDb(inserted) as unknown as BulkCrawlJobDependencies["db"],
      analyzeArticleSentiment,
      crawlNaverWebSearch: async () => [negative, ordinary],
      crawlDaumNews: async () => [],
      crawlAllSources: async () => [],
    });

    assert.deepEqual(
      inserted
        .filter(({ source }) => source === "naver_web")
        .map(({ title, isNegative, source }) => ({ title, isNegative, source })),
      [
        { title: negative.title, isNegative: true, source: "naver_web" },
        { title: ordinary.title, isNegative: false, source: "naver_web" },
      ],
    );
  });
});

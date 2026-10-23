import test from "node:test";
import assert from "node:assert/strict";
import ExcelJS from "exceljs";

process.env.DATABASE_URL ||= "postgres://audit:audit@127.0.0.1:1/audit";

test("manual URL text keeps valid unique HTTP addresses and reports invalid lines", async () => {
  const { parseUrlText } = await import("./manualImports");
  const parsed = parseUrlText("https://example.com/a#top\nnot-a-url\nhttps://example.com/a\nhttps://example.com/b");
  assert.deepEqual(parsed.urls, ["https://example.com/a", "https://example.com/b"]);
  assert.equal(parsed.invalid.length, 1);
});

test("article metadata prefers NewsArticle headline and parses Korean wall time", async () => {
  const { inspectArticleMetadata } = await import("./articleMetadata");
  const result = inspectArticleMetadata(`<html><head>
    <title>사이트 이름</title>
    <meta property="og:title" content="그룹 제목">
    <script type="application/ld+json">{"@type":"NewsArticle","headline":"노들섬 새 공연","datePublished":"2025.01.02 10:30"}</script>
  </head></html>`);
  assert.equal(result.title, "노들섬 새 공연");
  assert.equal(result.publishedAt, "2025-01-02T01:30:00.000Z");
});

test("BigKinds workbook recognizes Korean headers, imports related rows and uses a stable internal key without URL", async () => {
  const { importBigKindsWorkbook } = await import("./manualImports");
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("뉴스");
  sheet.addRow(["뉴스 식별자", "일자", "언론사", "제목", "키워드", "본문"]);
  sheet.addRow(["BK-1", "2025.01.02", "연합뉴스", "노들섬 새해 공연", "노들섬,공연", "노들섬에서 공연이 열렸다."]);
  sheet.addRow(["BK-2", "2025.01.03", "서울신문", "전혀 다른 기사", "경제", "관련 없는 본문"]);
  const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
  const inserted: Record<string, unknown>[] = [];
  const fakeDb = {
    select: () => ({ from: async () => [] }),
    insert: () => ({ values: (values: Record<string, unknown>[]) => ({
      onConflictDoNothing: () => ({ returning: async () => {
        inserted.push(...values);
        return values.map((value) => ({ url: value.url, source: value.source }));
      } }),
    }) }),
  };
  const result = await importBigKindsWorkbook(buffer, fakeDb as never);
  assert.equal(result.inserted, 1);
  assert.equal(result.irrelevant, 1);
  assert.equal(inserted[0]?.url, "bigkinds:BK-1");
  assert.match(String(result.metadata?.urlNote), /내부 키/);
});

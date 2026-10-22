import { Router, type IRouter } from "express";
import { db, articlesTable } from "@workspace/db";
import {
  eq,
  and,
  ilike,
  or,
  sql,
  gte,
  lte,
  desc,
  isNull,
  isNotNull,
  not,
} from "drizzle-orm";
import {
  ListArticlesQueryParams,
  ListTrashArticlesQueryParams,
  CreateArticleBody,
  UpdateArticleParams,
  UpdateArticleBody,
  DeleteArticleParams,
  RestoreArticleParams,
  AnalyzeArticleParams,
} from "@workspace/api-zod";
import { analyzeArticleSentiment } from "../lib/aiAnalysis";
import { logger } from "../lib/logger";
import ExcelJS from "exceljs";
import { relevantArticleCondition } from "../lib/articleRelevance";
import { isRelevant } from "../lib/newsRelevance";

const router: IRouter = Router();

// GET /articles
router.get("/articles", async (req, res): Promise<void> => {
  const parsed = ListArticlesQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { year, month, keyword, isNegative, isSelfPR, page = 1, limit = 20 } = parsed.data;
  const offset = (page - 1) * limit;

  const conditions = [isNull(articlesTable.deletedAt), relevantArticleCondition()];

  if (year != null) {
    conditions.push(
      sql`EXTRACT(YEAR FROM (${articlesTable.publishedAt} AT TIME ZONE 'Asia/Seoul')) = ${year}`,
    );
  }
  if (month != null) {
    conditions.push(
      sql`EXTRACT(MONTH FROM (${articlesTable.publishedAt} AT TIME ZONE 'Asia/Seoul')) = ${month}`,
    );
  }
  if (keyword) {
    const keywordCondition = or(
      ilike(articlesTable.title, `%${keyword}%`),
      ilike(articlesTable.content, `%${keyword}%`),
      ilike(articlesTable.mediaName, `%${keyword}%`),
    );
    if (keywordCondition) conditions.push(keywordCondition);
  }
  if (isNegative != null) {
    conditions.push(eq(articlesTable.isNegative, isNegative));
  }
  if (isSelfPR != null) {
    conditions.push(eq(articlesTable.isSelfPR, isSelfPR));
  }

  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const [articles, countResult] = await Promise.all([
    db
      .select()
      .from(articlesTable)
      .where(where)
      .orderBy(desc(articlesTable.publishedAt), desc(articlesTable.id))
      .limit(limit)
      .offset(offset),
    db
      .select({ count: sql<number>`COUNT(*)` })
      .from(articlesTable)
      .where(where),
  ]);

  const total = Number(countResult[0]?.count ?? 0);

  res.json({
    data: articles.map(serializeArticle),
    total,
    page,
    totalPages: Math.ceil(total / limit),
  });
});

// GET /articles/trash
router.get("/articles/trash", async (req, res): Promise<void> => {
  const parsed = ListTrashArticlesQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { page = 1, limit = 20 } = parsed.data;
  const offset = (page - 1) * limit;
  const where = isNotNull(articlesTable.deletedAt);

  const [articles, countResult] = await Promise.all([
    db
      .select()
      .from(articlesTable)
      .where(where)
      .orderBy(desc(articlesTable.deletedAt))
      .limit(limit)
      .offset(offset),
    db
      .select({ count: sql<number>`COUNT(*)` })
      .from(articlesTable)
      .where(where),
  ]);

  const total = Number(countResult[0]?.count ?? 0);

  res.json({
    data: articles.map(serializeArticle),
    total,
    page,
    totalPages: Math.ceil(total / limit),
  });
});

// POST /articles/trash-irrelevant — review or move only currently active nonmatches.
router.post("/articles/trash-irrelevant", async (req, res): Promise<void> => {
  const dryRun = req.body?.dryRun;
  if (typeof dryRun !== "boolean") {
    res.status(400).json({ error: "dryRun을 true 또는 false로 지정해 주세요." });
    return;
  }
  const where = and(isNull(articlesTable.deletedAt), not(relevantArticleCondition()));
  if (dryRun) {
    const [row] = await db.select({ count: sql<number>`COUNT(*)` }).from(articlesTable).where(where);
    res.json({ dryRun: true, count: Number(row?.count ?? 0) });
    return;
  }
  // One atomic soft-delete rechecks the predicate; existing trash is untouched.
  const moved = await db.update(articlesTable).set({ deletedAt: new Date() }).where(where)
    .returning({ id: articlesTable.id });
  res.json({ dryRun: false, count: moved.length });
});

// POST /articles
router.post("/articles", async (req, res): Promise<void> => {
  const parsed = CreateArticleBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const data = parsed.data;
  if (!isRelevant(data.title, data.content ?? "")) {
    res.status(400).json({ error: "제목 또는 본문에 노들섬, 예술섬노들, 글로벌 노들 예술섬, 노들 글로벌 예술섬 중 하나가 포함되어야 합니다." });
    return;
  }
  const publishedAt = new Date(data.publishedAt);
  if (isNaN(publishedAt.getTime())) {
    res.status(400).json({ error: "Invalid publishedAt date" });
    return;
  }

  const [article] = await db
    .insert(articlesTable)
    .values({
      title: data.title,
      content: data.content ?? "",
      url: data.url,
      publishedAt,
      mediaName: data.mediaName,
      isNegative: data.isNegative ?? false,
      isSelfPR: data.isSelfPR ?? false,
      source: data.source ?? "manual",
    })
    .returning();

  res.status(201).json(serializeArticle(article));
});

// PATCH /articles/:id
router.patch("/articles/:id", async (req, res): Promise<void> => {
  const params = UpdateArticleParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const body = UpdateArticleBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }

  const updates: Partial<{ isNegative: boolean; isSelfPR: boolean }> = {};
  if (body.data.isNegative != null) updates.isNegative = body.data.isNegative;
  if (body.data.isSelfPR != null) updates.isSelfPR = body.data.isSelfPR;

  const [article] = await db
    .update(articlesTable)
    .set(updates)
    .where(eq(articlesTable.id, params.data.id))
    .returning();

  if (!article) {
    res.status(404).json({ error: "Article not found" });
    return;
  }

  res.json(serializeArticle(article));
});

// DELETE /articles/:id
router.delete("/articles/:id", async (req, res): Promise<void> => {
  const params = DeleteArticleParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [deleted] = await db
    .update(articlesTable)
    .set({ deletedAt: new Date() })
    .where(
      and(
        eq(articlesTable.id, params.data.id),
        isNull(articlesTable.deletedAt),
      ),
    )
    .returning();

  if (!deleted) {
    res.status(404).json({ error: "Article not found" });
    return;
  }

  res.sendStatus(204);
});

// POST /articles/:id/restore
router.post("/articles/:id/restore", async (req, res): Promise<void> => {
  const params = RestoreArticleParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [restored] = await db
    .update(articlesTable)
    .set({ deletedAt: null })
    .where(
      and(
        eq(articlesTable.id, params.data.id),
        isNotNull(articlesTable.deletedAt),
      ),
    )
    .returning();

  if (!restored) {
    res.status(404).json({ error: "Deleted article not found" });
    return;
  }

  res.json(serializeArticle(restored));
});

// POST /articles/:id/analyze
router.post("/articles/:id/analyze", async (req, res): Promise<void> => {
  const params = AnalyzeArticleParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [existing] = await db
    .select()
    .from(articlesTable)
    .where(eq(articlesTable.id, params.data.id));

  if (!existing) {
    res.status(404).json({ error: "Article not found" });
    return;
  }

  try {
    const isNegative = await analyzeArticleSentiment(
      existing.title,
      existing.content,
    );
    const [updated] = await db
      .update(articlesTable)
      .set({ isNegative })
      .where(eq(articlesTable.id, params.data.id))
      .returning();

    res.json(serializeArticle(updated));
  } catch (err) {
    req.log.error({ err }, "AI analysis failed");
    res.status(500).json({ error: "AI analysis failed" });
  }
});

// GET /articles/export?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD
router.get("/articles/export", async (req, res): Promise<void> => {
  const { startDate, endDate } = req.query as { startDate?: string; endDate?: string };

  const conditions = [isNull(articlesTable.deletedAt), relevantArticleCondition()];
  if (startDate) {
    conditions.push(gte(articlesTable.publishedAt, new Date(startDate + "T00:00:00+09:00")));
  }
  if (endDate) {
    conditions.push(lte(articlesTable.publishedAt, new Date(endDate + "T23:59:59.999+09:00")));
  }
  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const articles = await db
    .select()
    .from(articlesTable)
    .where(where)
    .orderBy(desc(articlesTable.publishedAt), desc(articlesTable.id));

  const workbook = new ExcelJS.Workbook();
  workbook.creator = "노들섬 뉴스 모니터";
  const sheet = workbook.addWorksheet("언론보도");

  sheet.columns = [
    { header: "번호", key: "no", width: 6 },
    { header: "발행일", key: "publishedAt", width: 14 },
    { header: "언론사", key: "mediaName", width: 18 },
    { header: "제목", key: "title", width: 60 },
    { header: "URL", key: "url", width: 50 },
    { header: "부정기사", key: "isNegative", width: 10 },
    { header: "자체보도", key: "isSelfPR", width: 10 },
    { header: "출처", key: "source", width: 12 },
  ];

  // Header style
  const headerRow = sheet.getRow(1);
  headerRow.font = { bold: true };
  headerRow.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFD9E1F2" } };
  headerRow.alignment = { vertical: "middle", horizontal: "center" };

  articles.forEach((a, i) => {
    const kstDate = new Date(a.publishedAt.getTime() + 9 * 60 * 60 * 1000);
    const dateStr = kstDate.toISOString().split("T")[0];
    const row = sheet.addRow({
      no: i + 1,
      publishedAt: dateStr,
      mediaName: a.mediaName,
      title: a.title,
      url: a.url,
      isNegative: a.isNegative ? "예" : "",
      isSelfPR: a.isSelfPR ? "예" : "",
      source: a.source,
    });
    row.getCell("url").value = { text: a.url, hyperlink: a.url } as ExcelJS.CellHyperlinkValue;
    row.getCell("url").font = { color: { argb: "FF0070C0" }, underline: true };
    if (a.isNegative) {
      row.getCell("isNegative").font = { color: { argb: "FFFF0000" }, bold: true };
    }
  });

  // Freeze header row
  sheet.views = [{ state: "frozen", ySplit: 1 }];
  sheet.autoFilter = { from: "A1", to: "H1" };

  const safeName = (label: string) => label.replace(/[^a-zA-Z0-9가-힣_-]/g, "_");
  const rangeLabel = startDate && endDate
    ? `${safeName(startDate)}_${safeName(endDate)}`
    : "전체";
  const filename = encodeURIComponent(`노들섬_언론보도_${rangeLabel}.xlsx`);

  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${filename}`);

  await workbook.xlsx.write(res);
  res.end();
});

function serializeArticle(a: typeof articlesTable.$inferSelect) {
  return {
    id: a.id,
    title: a.title,
    content: a.content,
    url: a.url,
    publishedAt: a.publishedAt.toISOString(),
    mediaName: a.mediaName,
    isNegative: a.isNegative,
    isSelfPR: a.isSelfPR,
    source: a.source,
    createdAt: a.createdAt.toISOString(),
    deletedAt: a.deletedAt?.toISOString() ?? null,
  };
}

export default router;

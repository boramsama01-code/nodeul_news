import { Router, type IRouter } from "express";
import { db, articlesTable } from "@workspace/db";
import { eq, and, ilike, or, sql, gte, lte, desc } from "drizzle-orm";
import {
  ListArticlesQueryParams,
  CreateArticleBody,
  UpdateArticleParams,
  UpdateArticleBody,
  DeleteArticleParams,
  AnalyzeArticleParams,
} from "@workspace/api-zod";
import { analyzeArticleSentiment } from "../lib/aiAnalysis";
import { logger } from "../lib/logger";
import ExcelJS from "exceljs";

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

  const conditions = [];

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
    conditions.push(
      or(
        ilike(articlesTable.title, `%${keyword}%`),
        ilike(articlesTable.mediaName, `%${keyword}%`),
      ),
    );
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
      .orderBy(desc(articlesTable.publishedAt))
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

// POST /articles
router.post("/articles", async (req, res): Promise<void> => {
  const parsed = CreateArticleBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const data = parsed.data;
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
    .delete(articlesTable)
    .where(eq(articlesTable.id, params.data.id))
    .returning();

  if (!deleted) {
    res.status(404).json({ error: "Article not found" });
    return;
  }

  res.sendStatus(204);
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

  const conditions = [];
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
    .orderBy(desc(articlesTable.publishedAt));

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
  };
}

export default router;

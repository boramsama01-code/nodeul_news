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
      sql`EXTRACT(YEAR FROM ${articlesTable.publishedAt}) = ${year}`,
    );
  }
  if (month != null) {
    conditions.push(
      sql`EXTRACT(MONTH FROM ${articlesTable.publishedAt}) = ${month}`,
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

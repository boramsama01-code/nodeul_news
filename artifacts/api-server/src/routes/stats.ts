import { Router, type IRouter } from "express";
import { db, articlesTable } from "@workspace/db";
import { sql, and, gte, lte, desc } from "drizzle-orm";
import { GetMonthlyStatsQueryParams } from "@workspace/api-zod";

const router: IRouter = Router();

// GET /stats/monthly
router.get("/stats/monthly", async (req, res): Promise<void> => {
  const parsed = GetMonthlyStatsQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { year, startDate, endDate } = parsed.data;

  const conditions = [];

  if (year != null) {
    conditions.push(
      sql`EXTRACT(YEAR FROM ${articlesTable.publishedAt}) = ${year}`,
    );
  }

  if (startDate) {
    conditions.push(gte(articlesTable.publishedAt, new Date(startDate)));
  }

  if (endDate) {
    const ed = new Date(endDate);
    ed.setHours(23, 59, 59, 999);
    conditions.push(lte(articlesTable.publishedAt, ed));
  }

  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const rows = await db
    .select({
      month: sql<number>`EXTRACT(MONTH FROM ${articlesTable.publishedAt})`,
      total: sql<number>`COUNT(*)`,
      negative: sql<number>`COUNT(*) FILTER (WHERE ${articlesTable.isNegative} = true)`,
      selfPR: sql<number>`COUNT(*) FILTER (WHERE ${articlesTable.isSelfPR} = true)`,
    })
    .from(articlesTable)
    .where(where)
    .groupBy(sql`EXTRACT(MONTH FROM ${articlesTable.publishedAt})`)
    .orderBy(sql`EXTRACT(MONTH FROM ${articlesTable.publishedAt})`);

  // If year query, fill in missing months with 0
  if (year != null) {
    const byMonth = new Map<number, (typeof rows)[0]>();
    for (const r of rows) byMonth.set(Number(r.month), r);

    const result = Array.from({ length: 12 }, (_, i) => {
      const m = i + 1;
      const r = byMonth.get(m);
      const total = Number(r?.total ?? 0);
      const negative = Number(r?.negative ?? 0);
      const selfPR = Number(r?.selfPR ?? 0);
      return { month: m, total, negative, statistical: total - negative, selfPR };
    });

    res.json(result);
    return;
  }

  res.json(
    rows.map((r) => {
      const total = Number(r.total);
      const negative = Number(r.negative);
      const selfPR = Number(r.selfPR);
      return { month: Number(r.month), total, negative, statistical: total - negative, selfPR };
    }),
  );
});

// GET /stats/years
router.get("/stats/years", async (_req, res): Promise<void> => {
  const rows = await db
    .selectDistinct({
      year: sql<number>`EXTRACT(YEAR FROM ${articlesTable.publishedAt})`,
    })
    .from(articlesTable)
    .orderBy(sql`EXTRACT(YEAR FROM ${articlesTable.publishedAt}) DESC`);

  const years = rows.map((r) => Number(r.year));
  const currentYear = new Date().getFullYear();
  if (!years.includes(currentYear)) {
    years.unshift(currentYear);
  }

  res.json({ years });
});

// GET /stats/summary
router.get("/stats/summary", async (_req, res): Promise<void> => {
  const [row] = await db
    .select({
      totalArticles: sql<number>`COUNT(*)`,
      negativeCount: sql<number>`COUNT(*) FILTER (WHERE ${articlesTable.isNegative} = true)`,
      selfPRCount: sql<number>`COUNT(*) FILTER (WHERE ${articlesTable.isSelfPR} = true)`,
    })
    .from(articlesTable);

  const totalArticles = Number(row?.totalArticles ?? 0);
  const negativeCount = Number(row?.negativeCount ?? 0);
  const selfPRCount = Number(row?.selfPRCount ?? 0);

  res.json({
    totalArticles,
    statisticalCount: totalArticles - negativeCount,
    selfPRCount,
    negativeCount,
  });
});

// GET /stats/recent
router.get("/stats/recent", async (_req, res): Promise<void> => {
  const articles = await db
    .select()
    .from(articlesTable)
    .orderBy(desc(articlesTable.publishedAt))
    .limit(10);

  res.json(
    articles.map((a) => ({
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
    })),
  );
});

export default router;

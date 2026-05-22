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

  // All date calculations use KST (UTC+9) so Korean article dates display correctly
  const KST = `AT TIME ZONE 'Asia/Seoul'`;

  if (year != null) {
    conditions.push(
      sql`EXTRACT(YEAR FROM (${articlesTable.publishedAt} ${sql.raw(KST)})) = ${year}`,
    );
  }

  if (startDate) {
    conditions.push(gte(articlesTable.publishedAt, new Date(startDate + "T00:00:00+09:00")));
  }

  if (endDate) {
    conditions.push(lte(articlesTable.publishedAt, new Date(endDate + "T23:59:59.999+09:00")));
  }

  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const rows = await db
    .select({
      month: sql<number>`EXTRACT(MONTH FROM (${articlesTable.publishedAt} ${sql.raw(KST)}))`,
      total: sql<number>`COUNT(*)`,
      negative: sql<number>`COUNT(*) FILTER (WHERE ${articlesTable.isNegative} = true)`,
      selfPR: sql<number>`COUNT(*) FILTER (WHERE ${articlesTable.isSelfPR} = true)`,
    })
    .from(articlesTable)
    .where(where)
    .groupBy(sql`EXTRACT(MONTH FROM (${articlesTable.publishedAt} ${sql.raw(KST)}))`)
    .orderBy(sql`EXTRACT(MONTH FROM (${articlesTable.publishedAt} ${sql.raw(KST)}))`);

  // Fill in missing months with 0 when querying by year
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
      year: sql<number>`EXTRACT(YEAR FROM (${articlesTable.publishedAt} AT TIME ZONE 'Asia/Seoul'))`,
    })
    .from(articlesTable)
    .orderBy(sql`EXTRACT(YEAR FROM (${articlesTable.publishedAt} AT TIME ZONE 'Asia/Seoul')) DESC`);

  const years = rows.map((r) => Number(r.year));
  const currentYear = new Date().getFullYear();
  if (!years.includes(currentYear)) {
    years.unshift(currentYear);
  }

  res.json({ years });
});

// GET /stats/summary?year=2026
router.get("/stats/summary", async (req, res): Promise<void> => {
  const rawYear = req.query["year"];
  const year = rawYear != null && rawYear !== "" ? Number(rawYear) : null;

  const conditions = [];
  if (year != null && !isNaN(year)) {
    conditions.push(sql`EXTRACT(YEAR FROM (${articlesTable.publishedAt} AT TIME ZONE 'Asia/Seoul')) = ${year}`);
  }
  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const [[row], [allTimeRow]] = await Promise.all([
    db
      .select({
        totalArticles: sql<number>`COUNT(*)`,
        negativeCount: sql<number>`COUNT(*) FILTER (WHERE ${articlesTable.isNegative} = true)`,
        selfPRCount: sql<number>`COUNT(*) FILTER (WHERE ${articlesTable.isSelfPR} = true)`,
      })
      .from(articlesTable)
      .where(where),
    db
      .select({ totalAllTime: sql<number>`COUNT(*)` })
      .from(articlesTable),
  ]);

  const totalArticles = Number(row?.totalArticles ?? 0);
  const negativeCount = Number(row?.negativeCount ?? 0);
  const selfPRCount = Number(row?.selfPRCount ?? 0);
  const totalAllTime = Number(allTimeRow?.totalAllTime ?? 0);

  res.json({
    totalArticles,
    statisticalCount: totalArticles - negativeCount,
    selfPRCount,
    negativeCount,
    totalAllTime,
  });
});

// GET /stats/top-media?year=2026&limit=10
router.get("/stats/top-media", async (req, res): Promise<void> => {
  const rawYear = req.query["year"];
  const year = rawYear != null && rawYear !== "" ? Number(rawYear) : null;
  const limit = Math.min(Number(req.query["limit"] ?? 10), 30);

  const conditions = [];
  if (year != null && !isNaN(year)) {
    conditions.push(sql`EXTRACT(YEAR FROM (${articlesTable.publishedAt} AT TIME ZONE 'Asia/Seoul')) = ${year}`);
  }
  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const rows = await db
    .select({
      mediaName: articlesTable.mediaName,
      count: sql<number>`COUNT(*)`,
    })
    .from(articlesTable)
    .where(where)
    .groupBy(articlesTable.mediaName)
    .orderBy(sql`COUNT(*) DESC`)
    .limit(limit);

  res.json(rows.map((r) => ({ mediaName: r.mediaName, count: Number(r.count) })));
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

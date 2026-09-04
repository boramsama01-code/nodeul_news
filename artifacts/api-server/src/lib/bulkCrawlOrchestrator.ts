import { db } from "@workspace/db";
import { articlesTable, crawlJobsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "./logger";
import {
  isRelevant,
  isDuplicate,
  addToSet,
  isValidUrl,
  extractPressName,
  ArticleData,
} from "./crawlerUtils";
import { analyzeArticleSentiment } from "./aiAnalysis";
import { crawlAllSources, crawlNaverNews, crawlDaumNews, crawlNaverWebSearch } from "./crawlerSources";

export interface BulkCrawlJobDependencies {
  db?: typeof db;
  analyzeArticleSentiment?: typeof analyzeArticleSentiment;
  crawlAllSources?: typeof crawlAllSources;
  crawlNaverNews?: typeof crawlNaverNews;
  crawlDaumNews?: typeof crawlDaumNews;
  crawlNaverWebSearch?: typeof crawlNaverWebSearch;
}

// Return "YYYY-MM-DD" strings for each month boundary (no timezone conversion here;
// crawlerSources applies KST internally when it parses these strings).
function getMonthRanges(
  startDate: string,
  endDate: string,
): Array<{ start: string; end: string; label: string }> {
  const ranges: Array<{ start: string; end: string; label: string }> = [];
  const start = new Date(startDate + "T00:00:00");
  const end   = new Date(endDate   + "T00:00:00");

  let current = new Date(start.getFullYear(), start.getMonth(), 1);

  while (current <= end) {
    const monthStart = new Date(current);
    const monthEnd   = new Date(current.getFullYear(), current.getMonth() + 1, 0);

    const rangeStart = monthStart < start ? start : monthStart;
    const rangeEnd   = monthEnd   > end   ? end   : monthEnd;

    const label = `${current.getFullYear()}년 ${current.getMonth() + 1}월`;

    const fmt = (d: Date) =>
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

    ranges.push({ start: fmt(rangeStart), end: fmt(rangeEnd), label });

    current = new Date(current.getFullYear(), current.getMonth() + 1, 1);
  }

  return ranges;
}

async function loadExistingSet(database: typeof db): Promise<Set<string>> {
  const existingSet = new Set<string>();
  const existing = await database
    .select({
      url: articlesTable.url,
      title: articlesTable.title,
      publishedAt: articlesTable.publishedAt,
      source: articlesTable.source,
    })
    .from(articlesTable);

  for (const a of existing) {
    const src = a.source ?? "";
    existingSet.add(`${src}__` + a.url.toLowerCase().trim().replace(/\/$/, ""));
    const dateStr = a.publishedAt.toISOString().split("T")[0];
    existingSet.add(`${src}__${a.title.trim().replace(/\s+/g, "")}__${dateStr}`);
  }

  return existingSet;
}

export async function runBulkCrawlJob(
  jobId: string,
  startDate: string,
  endDate: string,
  dependencies: BulkCrawlJobDependencies = {},
): Promise<void> {
  const months = getMonthRanges(startDate, endDate);
  const totalMonths = months.length;

  logger.info({ jobId, totalMonths, startDate, endDate }, "Starting bulk crawl");

  const database = dependencies.db ?? db;
  const analyze = dependencies.analyzeArticleSentiment ?? analyzeArticleSentiment;
  const crawlSources = {
    all: dependencies.crawlAllSources ?? crawlAllSources,
    naver: dependencies.crawlNaverNews ?? crawlNaverNews,
    daum: dependencies.crawlDaumNews ?? crawlDaumNews,
    naverWeb: dependencies.crawlNaverWebSearch ?? crawlNaverWebSearch,
  };
  const existingSet = await loadExistingSet(database);
  // media_direct 중복 관리: "제목__언론사명" 완전일치 기준 (전체 크롤 범위 유지)
  const mediaDirectSet = new Set<string>();
  const sentimentCache = new Map<string, Promise<boolean>>();
  let totalCollected = 0;
  let totalDuplicates = 0;

  const getSentiment = (article: ArticleData): Promise<boolean> => {
    const key = `${article.title}\u0000${article.content}`;
    const cached = sentimentCache.get(key);
    if (cached) return cached;

    const analysis = analyze(article.title, article.content);
    sentimentCache.set(key, analysis);
    return analysis;
  };

  for (let i = 0; i < months.length; i++) {
    const month = months[i]!;
    const monthProgress = Math.round((i / totalMonths) * 90);

    await database
      .update(crawlJobsTable)
      .set({
        currentSource: `[${i + 1}/${totalMonths}] ${month.label} 수집 중…`,
        progress: monthProgress,
        collected: totalCollected,
        duplicates: totalDuplicates,
      })
      .where(eq(crawlJobsTable.id, jobId));

    logger.info({ jobId, month: month.label, start: month.start, end: month.end }, "Bulk crawl: processing month");

    const [naverApiRes, naverWebRes, daumRes, rssRes] = await Promise.allSettled([
      Promise.resolve([] as ArticleData[]), // naver_api 제외: start<=1000 제약으로 과거 수집 불가, naver_web으로 대체
      crawlSources.naverWeb(month.start, month.end),
      crawlSources.daum(month.start, month.end),
      crawlSources.all(month.start, month.end),
    ]);

    const naverApiResults = naverApiRes.status === "fulfilled" ? naverApiRes.value : [];
    const naverWebResults = naverWebRes.status === "fulfilled" ? naverWebRes.value : [];
    const daumResults     = daumRes.status     === "fulfilled" ? daumRes.value     : [];
    const rssResults      = rssRes.status      === "fulfilled" ? rssRes.value      : [];

    if (naverApiRes.status === "rejected") logger.error({ err: naverApiRes.reason, jobId, month: month.label }, "Naver API crawl failed for month");
    if (naverWebRes.status === "rejected") logger.error({ err: naverWebRes.reason, jobId, month: month.label }, "Naver web crawl failed for month");
    if (daumRes.status     === "rejected") logger.error({ err: daumRes.reason,     jobId, month: month.label }, "Daum crawl failed for month");
    if (rssRes.status      === "rejected") logger.error({ err: rssRes.reason,      jobId, month: month.label }, "RSS crawl failed for month");

    const articles: ArticleData[] = [...naverApiResults, ...naverWebResults, ...daumResults, ...rssResults];

    logger.info({ jobId, month: month.label, naverApi: naverApiResults.length, naverWeb: naverWebResults.length, daum: daumResults.length, rss: rssResults.length, count: articles.length }, "Bulk crawl: deduplicating month");

    for (const article of articles) {
      if (!isRelevant(article.title, article.content)) continue;
      if (!isValidUrl(article.url)) continue;
      if (isDuplicate(article.url, article.title, article.publishedAt, existingSet, article.source)) {
        totalDuplicates++;
        continue;
      }

      addToSet(article.url, article.title, article.publishedAt, existingSet, article.source);

      const isNegative = await getSentiment(article);

      try {
        await database.insert(articlesTable).values({
          title: article.title,
          content: article.content,
          url: article.url,
          publishedAt: article.publishedAt,
          mediaName: article.mediaName,
          isNegative,
          isSelfPR: article.isSelfPR,
          source: article.source,
        });
        totalCollected++;
      } catch (err: unknown) {
        const code = (err as { code?: string })?.code;
        if (code === "23505" || code === "P2002") {
          totalDuplicates++;
        } else {
          logger.error({ err }, "Failed to insert article");
        }
      }
    }

    // media_direct 파생: 포털 수집분 → 언론사 원게재 row (제목+언론사 완전일치 dedup)
    // 우선순위 naver_web > daum_web > google_news_rss (대표 URL 선택용)
    const mdPriority: Record<string, number> = { naver_web: 0, daum_web: 1, google_news_rss: 2 };
    const mdSorted = [...articles].sort(
      (a, b) => (mdPriority[a.source] ?? 9) - (mdPriority[b.source] ?? 9),
    );
    for (const article of mdSorted) {
      if (!isRelevant(article.title, article.content)) continue;
      if (!isValidUrl(article.url)) continue;
      const press = extractPressName(article.mediaName);
      const fp = article.title + "__" + press;
      if (mediaDirectSet.has(fp)) continue;
      mediaDirectSet.add(fp);
      try {
        const isNegative = await getSentiment(article);
        await database.insert(articlesTable).values({
          title: article.title,
          content: article.content,
          url: article.url,
          publishedAt: article.publishedAt,
          mediaName: press,
          isNegative,
          isSelfPR: article.isSelfPR,
          source: "media_direct",
        });
        totalCollected++;
      } catch (err: unknown) {
        const code = (err as { code?: string })?.code;
        if (code === "23505" || code === "P2002") totalDuplicates++;
        else logger.error({ err }, "Failed to insert media_direct");
      }
    }

    const progressAfterMonth = Math.round(((i + 1) / totalMonths) * 90);
    await database
      .update(crawlJobsTable)
      .set({
        collected: totalCollected,
        duplicates: totalDuplicates,
        progress: progressAfterMonth,
        total: totalCollected + totalDuplicates,
      })
      .where(eq(crawlJobsTable.id, jobId));

    // 월 간 지연: 네이버 rate limit 회복 (연속 요청 누적 차단 방지)
    if (i < months.length - 1) {
      await new Promise((r) => setTimeout(r, 5000));
    }
  }

  await database
    .update(crawlJobsTable)
    .set({
      status: "done",
      progress: 100,
      currentSource: "",
      total: totalCollected + totalDuplicates,
      collected: totalCollected,
      duplicates: totalDuplicates,
    })
    .where(eq(crawlJobsTable.id, jobId));

  logger.info({ jobId, totalCollected, totalDuplicates, totalMonths }, "Bulk crawl job complete");
}

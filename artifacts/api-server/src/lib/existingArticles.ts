import { db, articlesTable } from "@workspace/db";
import { and, eq, isNull } from "drizzle-orm";
import { addToSet, isDuplicate, isRelevant, type ArticleData } from "./crawlerUtils";
import { unidentifiedPublisher } from "./publisherMetrics";

// Exact source+URL matches survive publisher-name corrections. Deleted rows
// remain duplicates, so a scheduled collection cannot undo a user's deletion.
export async function loadExistingArticles(database: typeof db) {
  const rows = await database.select({
    id: articlesTable.id, url: articlesTable.url, title: articlesTable.title,
    publishedAt: articlesTable.publishedAt, source: articlesTable.source,
    mediaName: articlesTable.mediaName, deletedAt: articlesTable.deletedAt, content: articlesTable.content,
  }).from(articlesTable);
  const active = new Set<string>();
  const trash = new Set<string>();
  const exact = new Map(rows.map(row => [JSON.stringify([row.source, row.url]), row]));
  for (const row of rows) addToSet(row.url, row.title, row.publishedAt,
    row.deletedAt ? trash : active, row.source, row.mediaName);
  let repaired = 0;
  let refreshed = 0;
  let trashDuplicates = 0;
  return {
    needsReview(article: ArticleData) {
      const row = exact.get(JSON.stringify([article.source, article.url]));
      return !!row && !row.deletedAt && row.source !== "manual" && !isRelevant(row.title, row.content || "");
    },
    async refresh(article: ArticleData): Promise<boolean> {
      const row = exact.get(JSON.stringify([article.source, article.url]));
      if (!row || row.deletedAt || row.source === "manual" ||
          isRelevant(row.title, row.content || "") || !isRelevant(article.title, article.content)) return false;
      const value = {title: article.title, content: article.content, mediaName: article.mediaName, publishedAt: article.publishedAt};
      const updated = await database.update(articlesTable).set(value)
        .where(and(eq(articlesTable.id, row.id), isNull(articlesTable.deletedAt)))
        .returning({id: articlesTable.id});
      if (!updated.length) return false;
      Object.assign(row, value);
      refreshed++;
      return true;
    },
    async duplicate(article: ArticleData, collectedUrl = article.url) {
      const row = exact.get(JSON.stringify([article.source, article.url]))
        ?? exact.get(JSON.stringify([article.source, collectedUrl]));
      if (row) {
        if (row.deletedAt) { trashDuplicates++; return true; }
        if (row.source !== "manual" && unidentifiedPublisher(row.mediaName) && !unidentifiedPublisher(article.mediaName)) {
          const changed = await database.update(articlesTable).set({mediaName: article.mediaName})
            .where(and(eq(articlesTable.id, row.id), eq(articlesTable.mediaName, row.mediaName), isNull(articlesTable.deletedAt)))
            .returning({id: articlesTable.id});
          if (changed.length) {
            row.mediaName = article.mediaName;
            addToSet(row.url, row.title, row.publishedAt, active, row.source, row.mediaName);
            repaired++;
          }
        }
        return true;
      }
      if (isDuplicate(article.url, article.title, article.publishedAt, active, article.source, article.mediaName)) return true;
      if (isDuplicate(article.url, article.title, article.publishedAt, trash, article.source, article.mediaName)) {
        trashDuplicates++; return true;
      }
      return false;
    },
    remember(article: ArticleData) {
      addToSet(article.url, article.title, article.publishedAt, active, article.source, article.mediaName);
    },
    summary() { return `기존 기사 내용 갱신 ${refreshed}건, 언론사 보정 ${repaired}건, 휴지통 중복 제외 ${trashDuplicates}건 (중복 수에 포함)`; },
  };
}

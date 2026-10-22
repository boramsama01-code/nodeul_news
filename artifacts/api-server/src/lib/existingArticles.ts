import { db, articlesTable } from "@workspace/db";
import { and, eq, isNull } from "drizzle-orm";
import { addToSet, isRelevant, type ArticleData } from "./crawlerUtils";

const exactKey = (url: string, source: string) => JSON.stringify([source, url.trim()]);

export async function loadExistingArticles(database: typeof db) {
  const existingSet = new Set<string>();
  const refreshCandidates = new Map<string, number>();
  const existing = await database.select({
    id: articlesTable.id,
    url: articlesTable.url,
    title: articlesTable.title,
    content: articlesTable.content,
    publishedAt: articlesTable.publishedAt,
    source: articlesTable.source,
    mediaName: articlesTable.mediaName,
    deletedAt: articlesTable.deletedAt,
  }).from(articlesTable);

  for (const article of existing) {
    const relevant = isRelevant(article.title, article.content);
    // An excluded summary must not hide a different URL with a matching headline.
    addToSet(article.url, article.title, article.publishedAt, existingSet, article.source, relevant ? article.mediaName : undefined);
    if (!relevant && article.deletedAt === null) {
      refreshCandidates.set(exactKey(article.url, article.source), article.id);
    }
  }
  return { existingSet, refreshCandidates };
}

export async function refreshExcludedArticle(
  database: typeof db,
  existing: Awaited<ReturnType<typeof loadExistingArticles>>,
  article: ArticleData,
): Promise<boolean> {
  const key = exactKey(article.url, article.source);
  const id = existing.refreshCandidates.get(key);
  if (id === undefined) return false;
  const updated = await database.update(articlesTable).set({
    title: article.title,
    content: article.content,
    mediaName: article.mediaName,
    publishedAt: article.publishedAt,
  }).where(and(eq(articlesTable.id, id), isNull(articlesTable.deletedAt)))
    .returning({ id: articlesTable.id });
  existing.refreshCandidates.delete(key);
  if (updated.length === 0) return false;
  // User annotations and trash state are deliberately not part of the update.
  addToSet(article.url, article.title, article.publishedAt, existing.existingSet, article.source, article.mediaName);
  return true;
}

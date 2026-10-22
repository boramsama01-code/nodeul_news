import { articlesTable } from "@workspace/db";
import { sql, or } from "drizzle-orm";
import { COMPACT_KEYWORDS } from "./newsRelevance";

// Apply the collection rule to old archive rows without deleting original data.
export function relevantArticleCondition() {
  const whitespace = "[[:space:]\u00a0\u3000]+";
  return or(...COMPACT_KEYWORDS.flatMap(keyword => [
    sql`regexp_replace(${articlesTable.title}, ${whitespace}, '', 'g') LIKE ${`%${keyword}%`}`,
    sql`regexp_replace(${articlesTable.content}, ${whitespace}, '', 'g') LIKE ${`%${keyword}%`}`,
  ]))!;
}

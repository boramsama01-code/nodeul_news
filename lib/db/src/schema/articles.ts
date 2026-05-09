import { pgTable, text, serial, timestamp, boolean, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const articlesTable = pgTable(
  "articles",
  {
    id: serial("id").primaryKey(),
    title: text("title").notNull(),
    content: text("content").notNull().default(""),
    url: text("url").notNull().unique(),
    publishedAt: timestamp("published_at", { withTimezone: true }).notNull(),
    mediaName: text("media_name").notNull(),
    isNegative: boolean("is_negative").notNull().default(false),
    isSelfPR: boolean("is_self_pr").notNull().default(false),
    source: text("source").notNull().default(""),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("articles_published_at_idx").on(table.publishedAt),
    index("articles_media_name_idx").on(table.mediaName),
  ],
);

export const insertArticleSchema = createInsertSchema(articlesTable).omit({ id: true, createdAt: true });
export type InsertArticle = z.infer<typeof insertArticleSchema>;
export type Article = typeof articlesTable.$inferSelect;

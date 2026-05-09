import { pgTable, text, integer, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const crawlJobsTable = pgTable("crawl_jobs", {
  id: text("id").primaryKey(),
  status: text("status").notNull().default("running"),
  collected: integer("collected").notNull().default(0),
  duplicates: integer("duplicates").notNull().default(0),
  total: integer("total").notNull().default(0),
  progress: integer("progress").notNull().default(0),
  currentSource: text("current_source").notNull().default(""),
  error: text("error").notNull().default(""),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const insertCrawlJobSchema = createInsertSchema(crawlJobsTable).omit({ createdAt: true, updatedAt: true });
export type InsertCrawlJob = z.infer<typeof insertCrawlJobSchema>;
export type CrawlJob = typeof crawlJobsTable.$inferSelect;

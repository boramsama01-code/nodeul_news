import { AsyncLocalStorage } from "node:async_hooks";
import { logger } from "./logger";
import { GOOGLE_NEWS_QUERY } from "./newsRelevance";

export const crawlWarnings = new AsyncLocalStorage<string[]>();
export function warnSource(source: string, message: string): void {
  const warning = `${source}: ${message}`;
  logger.warn(warning);
  const warnings = crawlWarnings.getStore();
  if (warnings && !warnings.includes(warning)) warnings.push(warning);
}

export function kstDate(date = new Date()): string {
  return new Date(date.getTime() + 9 * 3600_000).toISOString().slice(0, 10);
}
export function shiftDate(date: string, days: number): string {
  return new Date(new Date(`${date}T00:00:00Z`).getTime() + days * 86400_000).toISOString().slice(0, 10);
}
export function validateDateRange(start: string, end: string): void {
  for (const value of [start, end]) {
    const parsed = new Date(`${value}T00:00:00Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
      throw new Error("날짜는 유효한 YYYY-MM-DD 형식이어야 합니다.");
    }
  }
  if (start > end) throw new Error("시작일은 종료일보다 늦을 수 없습니다.");
}

export function googleFeedUrl(raw: string, start: string, end: string): string {
  const url = new URL(raw);
  // Widen the search boundaries; exact filtering uses the item's KST timestamp.
  url.searchParams.set("q", `${url.searchParams.get("q") || `(${GOOGLE_NEWS_QUERY})`} after:${shiftDate(start, -1)} before:${shiftDate(end, 1)}`);
  return url.toString();
}

export async function mapConcurrent<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]);
    }
  }));
  return results;
}

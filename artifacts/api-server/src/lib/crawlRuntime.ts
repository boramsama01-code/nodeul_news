import { AsyncLocalStorage } from "node:async_hooks";
import { logger } from "./logger";
import { GOOGLE_NEWS_QUERY } from "./newsRelevance";

export const crawlWarnings = new AsyncLocalStorage<string[]>();
export type WarningSeverity = "incomplete" | "info";
// "info" = a fallback was attempted and will report its own outcome. Everything
// else means some part of the requested range was not verified.
const INFO_PREFIX = "[참고] ";
export function warnSource(source: string, message: string, severity: WarningSeverity = "incomplete"): void {
  const warning = `${severity === "info" ? INFO_PREFIX : ""}${source}: ${message}`;
  logger.warn(warning);
  const warnings = crawlWarnings.getStore();
  if (warnings && !warnings.includes(warning)) warnings.push(warning);
}
export function incompleteWarnings(warnings: readonly string[] = crawlWarnings.getStore() ?? []): string[] {
  return warnings.filter(warning => !warning.startsWith(INFO_PREFIX));
}
export type CrawlJobStatus = "done" | "partial" | "error";
export function decideJobStatus(input: { insertFailures: number; candidates: number; warnings: readonly string[]; strict?: boolean }): CrawlJobStatus {
  const incomplete = incompleteWarnings(input.warnings).length;
  if (input.insertFailures > 0) return "error";
  if (incomplete > 0 && (input.candidates === 0 || input.strict)) return "error";
  return incomplete > 0 ? "partial" : "done";
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

// Bound one request's network work: a single crawl covers at most maxDays.
export function validateCrawlSpan(start: string, end: string, maxDays: number): void {
  validateDateRange(start, end);
  const days = (Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86400_000 + 1;
  if (days > maxDays) throw new Error(`수집 기간은 최대 ${maxDays}일입니다.`);
  if (start < "2015-01-01") throw new Error("2015-01-01 이전 기간은 수집하지 않습니다.");
}

export function parseRssPublishedAt(item: {
  pubDate?: string; "dc:date"?: string; date?: string; isoDate?: string;
}): Date | null {
  // rss-parser derives isoDate using the server timezone for naive dates. Prefer
  // the publisher's original date, interpreting Korean feed wall time as KST.
  const found = [item.pubDate, item["dc:date"], item.date, item.isoDate]
    .find(value => typeof value === "string" && value.trim())?.trim();
  if (!found) return null;
  // Korean feeds also use "… 10:00:00 KST" and "2025.01.01 10:00" (wall time in KST).
  const dotted = found.match(/^(\d{4})\.(\d{1,2})\.(\d{1,2})\.?(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  const raw = dotted
    ? `${dotted[1]}-${dotted[2]!.padStart(2, "0")}-${dotted[3]!.padStart(2, "0")}${dotted[4] ? ` ${dotted[4].padStart(2, "0")}:${dotted[5]}:${dotted[6] ?? "00"}` : ""}`
    : found.replace(/\s+KST$/i, " +0900");
  const naive = raw.match(/^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(\.\d{1,3})?)?)?$/);
  const calendarDay = raw.match(/^(\d{4}-\d{2}-\d{2})(?:[T ]|$)/)?.[1];
  if (calendarDay) {
    try { validateDateRange(calendarDay, calendarDay); } catch { return null; }
  }
  let value = raw;
  if (naive) {
    const [, day, hour = "00", minute = "00", second = "00", fraction = ""] = naive;
    if (Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59) return null;
    value = `${day}T${hour}:${minute}:${second}${fraction}+09:00`;
  } else if (!/(?:Z|[+-]\d{2}:?\d{2}|GMT|UTC|UT)\s*$/i.test(raw)) {
    // Do not let host-local parsing invent a timezone for unknown formats.
    return null;
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return null;
  // Reject calendar roll-over in RFC 822 input ("31 Feb" must not become March).
  const rfc = raw.match(/^(?:[A-Za-z]{3},\s*)?(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})/);
  if (rfc) {
    const months = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
    const month = months.indexOf(rfc[2]!.toLowerCase()) + 1;
    const last = new Date(Date.UTC(Number(rfc[3]), month, 0)).getUTCDate();
    if (month < 1 || Number(rfc[1]) > last) return null;
  }
  return parsed;
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

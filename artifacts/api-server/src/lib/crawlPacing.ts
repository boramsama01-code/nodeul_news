import { logger } from "./logger";
import { validateDateRange } from "./crawlRuntime";

export interface DateRange {
  start: string;
  end: string;
}

// Keep earlier results when a later provider fails; never start every portal at once.
export async function settleSequentially<T>(tasks: Array<() => Promise<T>>, gapMs = 2000): Promise<PromiseSettledResult<T>[]> {
  const results: PromiseSettledResult<T>[] = [];
  for (const [index, task] of tasks.entries()) {
    try { results.push({status:"fulfilled", value:await task()}); }
    catch (reason) { results.push({status:"rejected", reason}); }
    if (gapMs > 0 && index < tasks.length - 1) await sleepWithJitter(gapMs,gapMs);
  }
  return results;
}

function parseIsoDate(value: string): Date {
  const parsed = new Date(`${value}T00:00:00Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new Error(`Invalid date: ${value}`);
  }
  return parsed;
}

function formatIsoDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

export function splitDateRangeByDays(startDate: string, endDate: string, days = 7): DateRange[] {
  validateDateRange(startDate, endDate);
  if (!Number.isInteger(days) || days < 1 || days > 31) throw new Error("days must be an integer between 1 and 31");

  const end = parseIsoDate(endDate);
  const ranges: DateRange[] = [];
  let cursor = parseIsoDate(startDate);

  while (cursor <= end) {
    const chunkEnd = new Date(cursor);
    chunkEnd.setUTCDate(chunkEnd.getUTCDate() + days - 1);
    if (chunkEnd > end) chunkEnd.setTime(end.getTime());
    ranges.push({ start: formatIsoDate(cursor), end: formatIsoDate(chunkEnd) });
    cursor = new Date(chunkEnd);
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return ranges;
}

export async function sleepWithJitter(minMs: number, maxMs: number): Promise<void> {
  const min = Math.max(0, Math.floor(minMs));
  const max = Math.max(min, Math.floor(maxMs));
  const delay = min + Math.floor(Math.random() * (max - min + 1));
  await new Promise((resolve) => setTimeout(resolve, delay));
}

export async function crawlDateChunks<T>(
  label: string,
  crawler: (startDate: string, endDate: string) => Promise<T[]>,
  startDate: string,
  endDate: string,
  options: { days?: number; pauseMinMs?: number; pauseMaxMs?: number } = {},
): Promise<T[]> {
  const ranges = splitDateRangeByDays(startDate, endDate, options.days ?? 7);
  const results: T[] = [];

  for (let index = 0; index < ranges.length; index++) {
    const range = ranges[index]!;
    logger.info({ label, range, index: index + 1, total: ranges.length }, "Paced date chunk started");
    results.push(...await crawler(range.start, range.end));
    if (index < ranges.length - 1) {
      await sleepWithJitter(options.pauseMinMs ?? 1800, options.pauseMaxMs ?? 3200);
    }
  }
  return results;
}

export async function mapInPacedBatches<T, R>(
  items: readonly T[],
  worker: (item: T) => Promise<R>,
  options: { batchSize?: number; concurrency?: number; pauseMinMs?: number; pauseMaxMs?: number } = {},
): Promise<R[]> {
  const batchSize = Math.max(1, Math.floor(options.batchSize ?? 4));
  const concurrency = Math.max(1, Math.floor(options.concurrency ?? 2));
  const output: R[] = [];

  for (let offset = 0; offset < items.length; offset += batchSize) {
    const batch = items.slice(offset, offset + batchSize);
    let cursor = 0;
    const workers = Array.from({ length: Math.min(concurrency, batch.length) }, async () => {
      while (cursor < batch.length) {
        const index = cursor++;
        output[offset + index] = await worker(batch[index]!);
      }
    });
    await Promise.all(workers);
    if (offset + batchSize < items.length) {
      await sleepWithJitter(options.pauseMinMs ?? 1400, options.pauseMaxMs ?? 2600);
    }
  }
  return output;
}

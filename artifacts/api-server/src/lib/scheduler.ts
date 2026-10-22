import { randomUUID } from "node:crypto";
import { readFile, mkdir, writeFile, rename } from "node:fs/promises";
import path from "node:path";
import { db, crawlJobsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { runCrawlJob } from "./crawlOrchestrator";
import { kstDate, shiftDate, validateDateRange } from "./crawlRuntime";
import { logger } from "./logger";
import { loadRuntimeConfig } from "./configStore";
import { readState, writeState, usesDatabaseState } from "./persistentState";

const statePath = () => path.resolve(process.env.DATA_DIR || ".local", "scheduler.json");
export function catchUpRange(now: Date, lastSuccess?: string) {
  const end = kstDate(now);
  const recent = shiftDate(end, -3);
  const prior = lastSuccess ? shiftDate(kstDate(new Date(lastSuccess)), -1) : recent;
  return { start: prior < recent ? prior : recent, end };
}

export async function collectOnce(start?: string, end?: string): Promise<boolean> {
  await loadRuntimeConfig();
  let lastSuccess: string | undefined;
  try {
    lastSuccess = usesDatabaseState()
      ? (await readState<{ lastSuccess: string }>("scheduler"))?.lastSuccess
      : JSON.parse(await readFile(statePath(), "utf8")).lastSuccess;
  }
  catch (err) {
    if (usesDatabaseState()) throw new Error("Could not read the persisted collection checkpoint.");
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") logger.warn("Could not read scheduler checkpoint; using recent date range");
  }
  if (lastSuccess && !Number.isFinite(new Date(lastSuccess).getTime())) lastSuccess = undefined;
  const began = new Date();
  const range = start && end ? { start, end } : catchUpRange(began, lastSuccess);
  validateDateRange(range.start, range.end);
  const jobId = randomUUID();
  await db.insert(crawlJobsTable).values({ id: jobId, currentSource: "자동 수집 시작" });
  try {
    await runCrawlJob(jobId, range.start, range.end);
    const [job] = await db.select().from(crawlJobsTable).where(eq(crawlJobsTable.id, jobId));
    if (job.status !== "done") return false;
    if (!start && !end) {
      const checkpoint = { lastSuccess: began.toISOString(), jobId, range };
      if (usesDatabaseState()) await writeState("scheduler", checkpoint);
      else {
        await mkdir(path.dirname(statePath()), { recursive: true });
        const temporary = `${statePath()}.${jobId}.tmp`;
        await writeFile(temporary, JSON.stringify(checkpoint, null, 2));
        await rename(temporary, statePath());
      }
    }
    return true;
  } catch (err) {
    logger.error({ jobId, message: String(err) }, "Collection failed");
    await db.update(crawlJobsTable).set({ status: "error", error: String(err) }).where(eq(crawlJobsTable.id, jobId));
    return false;
  }
}

export function startScheduler(): () => void {
  const minutes = Number(process.env.CRAWL_INTERVAL_MINUTES || 30);
  if (!Number.isFinite(minutes) || minutes < 5 || minutes > 1440) throw new Error("CRAWL_INTERVAL_MINUTES must be between 5 and 1440");
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const tick = async () => {
    if (stopped) return;
    try { await collectOnce(); }
    catch (err) { logger.error({ message: String(err) }, "Scheduler run failed; retrying next interval"); }
    if (!stopped) timer = setTimeout(tick, minutes * 60_000);
  };
  logger.info({ minutes }, "Independent scheduler starting");
  void tick();
  return () => { stopped = true; if (timer) clearTimeout(timer); };
}

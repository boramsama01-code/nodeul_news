import Parser from "rss-parser";
import { NEWS_SOURCES } from "./rssFeedList";
import { mapInPacedBatches } from "./crawlPacing";
import { parseRssPublishedAt } from "./crawlRuntime";
import { logger } from "./logger";
import { writeState } from "./persistentState";

const parser = new Parser({ timeout: 15_000, maxRedirects: 5 });

export interface RssHealthItem {
  name: string;
  url: string;
  status: "ok" | "empty" | "error";
  itemCount: number;
  newest?: string;
  oldest?: string;
  error?: string;
}

export async function auditDirectRssFeeds(): Promise<{
  checkedAt: string;
  ok: number;
  empty: number;
  failed: number;
  items: RssHealthItem[];
}> {
  const unique = new Map<string, { name: string; url: string }>();
  for (const source of NEWS_SOURCES) {
    if (source.method === "rss_direct" && !unique.has(source.url)) {
      unique.set(source.url, { name: source.name, url: source.url });
    }
  }

  const items = await mapInPacedBatches(
    [...unique.values()],
    async (source): Promise<RssHealthItem> => {
      try {
        const feed = await parser.parseURL(source.url);
        const dates = (feed.items ?? [])
          .map(parseRssPublishedAt)
          .filter((value): value is Date => !!value)
          .sort((a, b) => a.getTime() - b.getTime());
        return {
          ...source,
          status: (feed.items?.length ?? 0) > 0 ? "ok" : "empty",
          itemCount: feed.items?.length ?? 0,
          oldest: dates[0]?.toISOString(),
          newest: dates[dates.length - 1]?.toISOString(),
        };
      } catch (error) {
        return {
          ...source,
          status: "error",
          itemCount: 0,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
    { batchSize: 4, concurrency: 2, pauseMinMs: 1800, pauseMaxMs: 3400 },
  );

  const report = {
    checkedAt: new Date().toISOString(),
    ok: items.filter((item) => item.status === "ok").length,
    empty: items.filter((item) => item.status === "empty").length,
    failed: items.filter((item) => item.status === "error").length,
    items,
  };
  try { await writeState("rss-health-audit-latest", report); }
  catch { /* local deployments may not use app_state */ }
  logger.info(
    { checked: items.length, ok: report.ok, empty: report.empty, failed: report.failed },
    "Direct RSS health audit complete",
  );
  for (const item of items.filter((entry) => entry.status !== "ok")) {
    logger.warn(
      { name: item.name, url: item.url, status: item.status, error: item.error },
      "Direct RSS health issue",
    );
  }
  return report;
}

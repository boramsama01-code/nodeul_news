import { NEWS_SOURCES } from "./rssFeedList";
import { mapInPacedBatches } from "./crawlPacing";
import { parseRssPublishedAt } from "./crawlRuntime";
import { logger } from "./logger";
import { writeState } from "./persistentState";
import { loadOfficialRssFeed, type FeedParseMode } from "./rssTransport";

export interface RssHealthItem {
  name: string;
  url: string;
  resolvedUrl?: string;
  parseMode?: FeedParseMode;
  discovered?: boolean;
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
  discovered: number;
  repaired: number;
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
        const loaded = await loadOfficialRssFeed(source.url);
        const dates = (loaded.feed.items ?? [])
          .map(parseRssPublishedAt)
          .filter((value): value is Date => !!value)
          .sort((a, b) => a.getTime() - b.getTime());
        return {
          ...source,
          resolvedUrl: loaded.resolvedUrl,
          parseMode: loaded.parseMode,
          discovered: loaded.discovered,
          status: (loaded.feed.items?.length ?? 0) > 0 ? "ok" : "empty",
          itemCount: loaded.feed.items?.length ?? 0,
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
    { batchSize: 3, concurrency: 2, pauseMinMs: 2000, pauseMaxMs: 3800 },
  );

  const report = {
    checkedAt: new Date().toISOString(),
    ok: items.filter((item) => item.status === "ok").length,
    empty: items.filter((item) => item.status === "empty").length,
    failed: items.filter((item) => item.status === "error").length,
    discovered: items.filter((item) => item.discovered).length,
    repaired: items.filter((item) => item.parseMode === "sanitized-xml" || item.parseMode === "tolerant-xml").length,
    items,
  };
  try { await writeState("rss-health-audit-latest", report); }
  catch { /* local deployments may not use app_state */ }
  logger.info(
    {
      checked: items.length,
      ok: report.ok,
      empty: report.empty,
      failed: report.failed,
      discovered: report.discovered,
      repaired: report.repaired,
    },
    "Direct RSS health audit complete",
  );
  for (const item of items.filter((entry) => entry.status !== "ok")) {
    logger.warn(
      { name: item.name, url: item.url, resolvedUrl: item.resolvedUrl, status: item.status, error: item.error },
      "Direct RSS health issue",
    );
  }
  for (const item of items.filter((entry) => entry.status === "ok" && (entry.discovered || entry.parseMode !== "rss-parser"))) {
    logger.info(
      {
        name: item.name,
        url: item.url,
        resolvedUrl: item.resolvedUrl,
        parseMode: item.parseMode,
        itemCount: item.itemCount,
      },
      "Direct RSS recovered",
    );
  }
  return report;
}

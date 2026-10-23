import { NEWS_SOURCES, type NewsSource } from "./rssFeedList";
import { mapInPacedBatches } from "./crawlPacing";
import { logger } from "./logger";
import { writeState } from "./persistentState";
import { loadOfficialFeed, type OfficialFeedResult } from "./sourceFeeds";

export interface RssHealthItem {
  name: string;
  url: string;
  resolvedUrl?: string;
  parseMode?: string;
  discovered?: boolean;
  status: "ok" | "empty" | "error";
  support?: OfficialFeedResult["status"];
  kind?: OfficialFeedResult["kind"];
  reason?: string;
  requestCount?: number;
  itemCount: number;
  newest?: string;
  oldest?: string;
  error?: string;
}

function compactAttempts(result: OfficialFeedResult): string {
  return result.attempts
    .slice(0, 4)
    .map((attempt) => {
      const status = attempt.status ? ` HTTP ${attempt.status}` : "";
      const detail = attempt.detail ? ` (${attempt.detail})` : "";
      return `${attempt.outcome}${status}${detail}`;
    })
    .join(" | ");
}

function parseMode(result: OfficialFeedResult): string | undefined {
  const repaired = result.attempts.find((attempt) => attempt.outcome.startsWith("feed_repaired_"));
  if (repaired) return repaired.outcome.replace("feed_repaired_", "");
  if (result.attempts.some((attempt) => attempt.outcome === "feed_ok")) return "rss-parser";
  if (result.kind === "news_sitemap") return "news-sitemap";
  return undefined;
}

function toHealthItem(source: NewsSource, result: OfficialFeedResult): RssHealthItem {
  const itemCount = result.feed.items.length;
  const status: RssHealthItem["status"] = itemCount > 0
    ? "ok"
    : result.status === "unsupported" ? "error" : "empty";
  const discovered = !!result.endpoint && result.endpoint !== source.url;
  const error = status === "error"
    ? [result.reason, compactAttempts(result)].filter(Boolean).join(": ")
    : undefined;
  return {
    name: source.name,
    url: source.url,
    resolvedUrl: result.endpoint ?? undefined,
    parseMode: parseMode(result),
    discovered,
    status,
    support: result.status,
    kind: result.kind,
    reason: result.reason,
    requestCount: result.requestCount,
    itemCount,
    oldest: result.oldestPublishedAt,
    newest: result.newestPublishedAt,
    error,
  };
}

export type SupportLevel = "normal" | "partial" | "unsupported";

export interface PublisherSourceHealth {
  name: string;
  domain: string;
  method: "rss_direct";
  status: SupportLevel;
  reason: string;
  endpoint?: string;
  scope: "whole" | "section";
  feedCount: number;
  usableFeeds: number;
  itemCount: number;
  newest?: string;
  oldest?: string;
  feeds: { endpoint: string; kind?: string | null; status: SupportLevel; reason: string; itemCount: number; newest?: string; oldest?: string }[];
}

// The loader's own support level decides the label. "Items present" is not the
// same as "normal": a news sitemap only lists recent articles, a repaired feed
// may be incomplete. Reports written before `support` existed are shown as
// partial at best, never as normal.
export function feedSupportLevel(item: RssHealthItem): SupportLevel {
  if (item.support === "normal" && item.itemCount > 0) return "normal";
  if (item.support === "partial" || (item.support === "normal" && item.itemCount === 0)) return "partial";
  if (item.support === "unsupported") return "unsupported";
  return item.status === "ok" ? "partial" : "unsupported";
}

function feedReason(item: RssHealthItem, level: SupportLevel): string {
  if (item.reason) return item.reason;
  if (!item.support) return level === "partial" ? "legacy_report_without_support_level" : item.error || "no_usable_official_feed";
  return item.error || "no_usable_official_feed";
}

// One row per publisher. Several section feeds of one paper are one source,
// not several "normal" sources.
export function summarizeSourceHealth(items: RssHealthItem[]): { summary: Record<SupportLevel, number> & { publishers: number; feeds: number }; sources: PublisherSourceHealth[] } {
  const groups = new Map<string, RssHealthItem[]>();
  for (const item of items) groups.set(item.name, [...(groups.get(item.name) ?? []), item]);
  const sources = [...groups.entries()].map(([name, group]): PublisherSourceHealth => {
    const feeds = group.map((item) => {
      const status = feedSupportLevel(item);
      return { endpoint: item.resolvedUrl || item.url, kind: item.kind, status, reason: feedReason(item, status), itemCount: item.itemCount, newest: item.newest, oldest: item.oldest };
    });
    const usable = feeds.filter((feed) => feed.status !== "unsupported");
    const scope = group.length > 1 ? "section" : "whole";
    const status: SupportLevel = usable.length === 0 ? "unsupported"
      : usable.length === feeds.length && feeds.every((feed) => feed.status === "normal") ? "normal" : "partial";
    const reason = status === "unsupported" ? feeds[0].reason
      : scope === "section" ? `section_feeds:${usable.length}/${feeds.length}`
      : feeds[0].reason;
    const dates = (key: "newest" | "oldest") => usable.map((feed) => feed[key]).filter((value): value is string => !!value).sort();
    let domain = "";
    try { domain = new URL(group[0].url).hostname; } catch { domain = ""; }
    return {
      name, domain, method: "rss_direct", status, reason, scope,
      endpoint: (usable[0] ?? feeds[0]).endpoint,
      feedCount: feeds.length, usableFeeds: usable.length,
      itemCount: usable.reduce((sum, feed) => sum + feed.itemCount, 0),
      newest: dates("newest").at(-1), oldest: dates("oldest")[0],
      feeds,
    };
  });
  const count = (level: SupportLevel) => sources.filter((source) => source.status === level).length;
  return { summary: { publishers: sources.length, feeds: items.length, normal: count("normal"), partial: count("partial"), unsupported: count("unsupported") }, sources };
}

export async function auditDirectRssFeeds(): Promise<{
  checkedAt: string;
  ok: number;
  empty: number;
  failed: number;
  discovered: number;
  repaired: number;
  requests: number;
  items: RssHealthItem[];
}> {
  const unique = new Map<string, NewsSource>();
  for (const source of NEWS_SOURCES) {
    if (source.method === "rss_direct" && !unique.has(source.url)) unique.set(source.url, source);
  }

  const sources = [...unique.values()];
  const items = await mapInPacedBatches(
    sources,
    async (source): Promise<RssHealthItem> => {
      try {
        // sourceFeeds enforces official-domain redirects, a 12-second redirect-chain
        // deadline, a 3 MiB response cap, and at most 8 document requests per source.
        return toHealthItem(source, await loadOfficialFeed(source, {
          discovery: true,
          maxRequests: 8,
          refresh: true,
        }));
      } catch (error) {
        return {
          name: source.name,
          url: source.url,
          status: "error",
          itemCount: 0,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
    { batchSize: 4, concurrency: 4, pauseMinMs: 1400, pauseMaxMs: 2600 },
  );

  const report = {
    checkedAt: new Date().toISOString(),
    ok: items.filter((item) => item.status === "ok").length,
    empty: items.filter((item) => item.status === "empty").length,
    failed: items.filter((item) => item.status === "error").length,
    discovered: items.filter((item) => item.discovered).length,
    repaired: items.filter((item) => item.parseMode && item.parseMode !== "rss-parser").length,
    requests: items.reduce((sum, item) => sum + (item.requestCount ?? 0), 0),
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
      requests: report.requests,
    },
    "Direct RSS health audit complete",
  );
  for (const item of items.filter((entry) => entry.status !== "ok")) {
    logger.warn(
      {
        name: item.name,
        url: item.url,
        resolvedUrl: item.resolvedUrl,
        support: item.support,
        reason: item.reason,
        requests: item.requestCount,
        error: item.error,
      },
      "Direct RSS health issue",
    );
  }
  for (const item of items.filter((entry) => entry.status === "ok" && (entry.discovered || entry.parseMode !== "rss-parser"))) {
    logger.info(
      {
        name: item.name,
        url: item.url,
        resolvedUrl: item.resolvedUrl,
        support: item.support,
        parseMode: item.parseMode,
        requests: item.requestCount,
        itemCount: item.itemCount,
      },
      "Direct RSS recovered",
    );
  }
  return report;
}

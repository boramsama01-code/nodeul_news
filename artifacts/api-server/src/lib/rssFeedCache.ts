import { AsyncLocalStorage } from "node:async_hooks";
import { loadOfficialRssFeed } from "./rssTransport";

// Direct RSS is a current snapshot, identical for every month in a bulk job.
// Keep raw feed promises so concurrent requests and failures are shared too.
// This storage is created per job; separate crawls always get fresh snapshots.
const bulkFeedCache = new AsyncLocalStorage<Map<string, Promise<unknown>>>();

export function withBulkFeedCache<T>(run: () => T): T {
  return bulkFeedCache.run(new Map(), run);
}

export function fetchRssFeed<T>(
  method: "rss_direct" | "google_news_rss",
  url: string,
  load: () => Promise<T>,
): Promise<T> {
  const actualLoad = method === "rss_direct"
    ? async () => (await loadOfficialRssFeed(url)).feed as T
    : load;
  const cache = method === "rss_direct" ? bulkFeedCache.getStore() : undefined;
  if (!cache) return Promise.resolve().then(actualLoad);
  const existing = cache.get(url);
  if (existing) return existing as Promise<T>;
  const pending = Promise.resolve().then(actualLoad);
  cache.set(url, pending);
  return pending;
}

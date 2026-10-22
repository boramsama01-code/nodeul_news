import test from "node:test";
import assert from "node:assert/strict";
import { fetchRssFeed, withBulkFeedCache } from "./rssFeedCache";

test("one bulk job shares concurrent direct RSS loads and later month snapshots", async () => {
  let calls = 0;
  const load = async () => { calls++; return { items: [{ id: calls }] }; };
  await withBulkFeedCache(async () => {
    const first = fetchRssFeed("rss_direct", "https://press.example/rss", load);
    const concurrent = fetchRssFeed("rss_direct", "https://press.example/rss", load);
    assert.equal(first, concurrent);
    const [a, b] = await Promise.all([first, concurrent]);
    assert.equal(a, b);
    assert.equal(await fetchRssFeed("rss_direct", "https://press.example/rss", load), a);
    assert.equal(calls, 1);
    await fetchRssFeed("rss_direct", "https://press.example/culture", load);
    assert.equal(calls, 2);
  });
});

test("overlapping bulk jobs and later jobs never share feed snapshots", async () => {
  let calls = 0;
  const run = (label: string) => withBulkFeedCache(async () => {
    const load = async () => { calls++; await Promise.resolve(); return label; };
    const first = await fetchRssFeed("rss_direct", "https://press.example/rss", load);
    await Promise.resolve();
    assert.equal(await fetchRssFeed("rss_direct", "https://press.example/rss", load), label);
    return first;
  });
  assert.deepEqual(await Promise.all([run("job-a"), run("job-b")]), ["job-a", "job-b"]);
  assert.equal(calls, 2);
  assert.equal(await run("job-c"), "job-c");
  assert.equal(calls, 3);
});

test("Google searches and normal direct crawls are not cached", async () => {
  let calls = 0;
  const load = async () => ++calls;
  await withBulkFeedCache(async () => {
    assert.deepEqual(await Promise.all([
      fetchRssFeed("google_news_rss", "https://news.google.com/rss/search", load),
      fetchRssFeed("google_news_rss", "https://news.google.com/rss/search", load),
    ]), [1, 2]);
  });
  assert.equal(await fetchRssFeed("rss_direct", "https://press.example/rss", load), 3);
  assert.equal(await fetchRssFeed("rss_direct", "https://press.example/rss", load), 4);
});

test("failed direct feed loads are reused while every month can run its own fallback", async () => {
  let directCalls = 0;
  const fallbackMonths: string[] = [];
  const failure = new Error("feed unavailable");
  const load = async () => { directCalls++; throw failure; };
  await withBulkFeedCache(async () => {
    for (const month of ["2026-01", "2026-02"]) {
      try { await fetchRssFeed("rss_direct", "https://press.example/rss", load); }
      catch (error) {
        assert.equal(error, failure);
        fallbackMonths.push(await fetchRssFeed("google_news_rss", `https://news.google.com/rss?month=${month}`, async () => month));
      }
    }
  });
  assert.equal(directCalls, 1);
  assert.deepEqual(fallbackMonths, ["2026-01", "2026-02"]);
  await withBulkFeedCache(() => assert.rejects(fetchRssFeed("rss_direct", "https://press.example/rss", load), /feed unavailable/));
  assert.equal(directCalls, 2);
});

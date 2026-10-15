import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { enrichArticles } from "./lib/publisherResolver";
import { resolveMediaNameStrict, extractPressName, type ArticleData } from "./lib/crawlerUtils";
import { publisherMetrics, unidentifiedPublisher } from "./lib/publisherMetrics";

const args = process.argv.slice(2);
const option = (name: string) => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; };
const input = option("--input");
const apply = args.includes("--apply");
const year = option("--year") ? Number(option("--year")) : null;
if(year!==null && (!Number.isInteger(year)||year<1900||year>2200))throw Error("Invalid year");
if (input && apply) throw new Error("Snapshot comparison cannot modify the database.");
const maximum = args.includes("--offline") ? 0 : Number(option("--max-requests") || 300);
if (!Number.isInteger(maximum) || maximum < 0 || maximum > 2000) throw new Error("max-requests must be 0..2000");
const reportFile = option("--report") || join(process.env.DATA_DIR || ".local", "reports", `publisher-repair-${Date.now()}.json`);
type Row = ArticleData & { id: number };
let pool: (typeof import("@workspace/db"))["pool"] | undefined;
let client: { query: NonNullable<typeof pool>["query"]; release: () => void } | undefined;
try {
  let rows: Row[];
  if (input) {
    const snapshot = JSON.parse(await readFile(input, "utf8"));
    rows = (Array.isArray(snapshot) ? snapshot : snapshot.data || snapshot.articles).map((a: Row) => ({ ...a, publishedAt: new Date(a.publishedAt) }));
  } else {
    ({ pool } = await import("@workspace/db"));
    client = await pool.connect();
    const lock = await client.query("SELECT pg_try_advisory_lock(739421) AS acquired");
    if (!lock.rows[0].acquired) throw new Error("다른 수집이 실행 중입니다. 완료 후 다시 실행하세요.");
    rows = (await client.query('SELECT id, title, content, url, published_at AS "publishedAt", media_name AS "mediaName", is_negative AS "isNegative", is_self_pr AS "isSelfPR", source FROM articles WHERE deleted_at IS NULL ORDER BY id')).rows;
  }
  if(year!==null)rows=rows.filter(a=>new Date(new Date(a.publishedAt).getTime()+32400000).getUTCFullYear()===year);
  const targets = rows.filter(a => a.source !== "manual" && (args.includes("--all-links") || unidentifiedPublisher(a.mediaName) ||
    (resolveMediaNameStrict(a.url) && resolveMediaNameStrict(a.url) !== extractPressName(a.mediaName))));
  // A request budget bounds each run; cached/domain-only resolutions are free.
  const enriched = await enrichArticles(targets, { maxRequests: maximum });
  const updated = new Map(enriched.map(a => [a.id, a]));
  const after = rows.map(a => updated.get(a.id) || a);
  const changes = rows.flatMap(a => {
    const next = updated.get(a.id);
    return next && next.mediaName !== a.mediaName ? [{ id: a.id, source: a.source, before: {url:a.url, mediaName:a.mediaName}, after: {url:a.url, mediaName:next.mediaName} }] : [];
  });
  const report = { checkedAt: new Date().toISOString(), mode: apply ? "apply" : "preview", requestBudget: maximum,
    targetCount: targets.length, before: publisherMetrics(rows), proposedAfter: publisherMetrics(after), changes,
    applied: 0, skippedConcurrentEdits: 0, preservedUrlCollisions: 0 };
  await mkdir(dirname(reportFile), {recursive:true});
  // Save old values before any update; this is also an exact rollback record.
  await writeFile(reportFile, JSON.stringify(report, null, 2), {flag:"wx"});
  if (apply && client) {
    await client.query("BEGIN");
    try {
      for (const change of changes) {
        const result = await client.query("UPDATE articles SET media_name=$1 WHERE id=$2 AND media_name=$3 AND url=$4 AND deleted_at IS NULL", [change.after.mediaName, change.id, change.before.mediaName, change.before.url]);
        if (result.rowCount) report.applied++; else report.skippedConcurrentEdits++;
      }
      await client.query("COMMIT");
    } catch (err) { await client.query("ROLLBACK"); throw err; }
    await writeFile(reportFile, JSON.stringify(report, null, 2));
  }
  console.log(JSON.stringify({ reportFile, ...report, changes: changes.length }, null, 2));
} finally {
  if (client) { await client.query("SELECT pg_advisory_unlock(739421)"); client.release(); }
  if (pool) await pool.end();
}

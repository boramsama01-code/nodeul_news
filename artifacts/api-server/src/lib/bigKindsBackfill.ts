import axios from "axios";
import ExcelJS from "exceljs";
import { gunzipSync } from "node:zlib";
import { db, articlesTable, pool } from "@workspace/db";
import { importBigKindsWorkbook } from "./manualImports";
import { extractPressName, isValidUrl, resolveMediaNameStrict, stripHtml } from "./crawlerUtils";
import { trashKey } from "./existingArticles";
import { logger } from "./logger";
import { readState, writeState } from "./persistentState";

export interface BigKindsPayloadRow {
  i: string;
  d: string;
  m: string;
  t: string;
  c: string;
  u: string;
}

interface BackfillState {
  importDone?: boolean;
  importSummary?: { total: number; inserted: number; duplicates: number; irrelevant: number; failed: number };
  naverIndex?: number;
  naverQueries?: number;
  naverMatches?: number;
  naverInserted?: number;
  naverFailures?: number;
  kakaoIndex?: number;
  kakaoQueries?: number;
  kakaoMatches?: number;
  kakaoInserted?: number;
  kakaoFailures?: number;
  completedAt?: string;
  note?: string;
  updatedAt?: string;
}

interface ExistingRow {
  url: string;
  title: string;
  mediaName: string;
  publishedAt: Date;
}

interface RouteInfo {
  hasDirect: boolean;
  hasNaver: boolean;
  hasDaum: boolean;
}

interface NaverItem {
  title?: string;
  description?: string;
  link?: string;
  originallink?: string;
  pubDate?: string;
}

interface KakaoDocument {
  title?: string;
  contents?: string;
  url?: string;
  datetime?: string;
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function normalizedTitle(value: string): string {
  return stripHtml(value)
    .normalize("NFKC")
    .toLowerCase()
    .replace(/^\[[^\]]{1,40}\]\s*/u, "")
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

function bigrams(value: string): Set<string> {
  const result = new Set<string>();
  for (let index = 0; index < value.length - 1; index++) result.add(value.slice(index, index + 2));
  return result;
}

export function titlesEquivalent(left: string, right: string): boolean {
  const a = normalizedTitle(left);
  const b = normalizedTitle(right);
  if (!a || !b) return false;
  if (a === b) return true;
  const shorter = a.length <= b.length ? a : b;
  const longer = a.length > b.length ? a : b;
  if (shorter.length >= 12 && longer.includes(shorter) && shorter.length / longer.length >= 0.78) return true;
  const aa = bigrams(a), bb = bigrams(b);
  if (!aa.size || !bb.size) return false;
  let overlap = 0;
  for (const item of aa) if (bb.has(item)) overlap++;
  const dice = (2 * overlap) / (aa.size + bb.size);
  return dice >= 0.9;
}

function normalizedMedia(value: string): string {
  return extractPressName(value).normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

function kstDay(date: Date): string {
  return new Date(date.getTime() + 9 * 3600_000).toISOString().slice(0, 10);
}

export function parseBigKindsDate(value: string): Date | null {
  const match = /^(\d{4})(\d{2})(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const day = `${match[1]}-${match[2]}-${match[3]}`;
  const date = new Date(`${day}T12:00:00+09:00`);
  return Number.isFinite(date.getTime()) && kstDay(date) === day ? date : null;
}

function dayDistance(left: Date, right: Date): number {
  const a = Date.parse(`${kstDay(left)}T00:00:00Z`);
  const b = Date.parse(`${kstDay(right)}T00:00:00Z`);
  return Math.round(Math.abs(a - b) / 86_400_000);
}

function storyKey(row: Pick<ExistingRow, "title" | "mediaName" | "publishedAt">): string {
  return JSON.stringify([normalizedMedia(row.mediaName), kstDay(row.publishedAt), normalizedTitle(row.title)]);
}

function canonicalUrl(raw: string): string {
  try { return trashKey(raw); }
  catch { return raw.trim(); }
}

function routeKind(raw: string): "naver" | "daum" | "direct" | "internal" {
  try {
    const url = new URL(raw);
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    if (host === "naver.com" || host.endsWith(".naver.com") || host === "naver.me") return "naver";
    if (host === "daum.net" || host.endsWith(".daum.net")) return "daum";
    return "direct";
  } catch { return "internal"; }
}

function buildIndexes(rows: ExistingRow[]) {
  const urls = new Set<string>();
  const routes = new Map<string, RouteInfo>();
  for (const row of rows) {
    urls.add(canonicalUrl(row.url));
    const key = storyKey(row);
    const current = routes.get(key) ?? { hasDirect: false, hasNaver: false, hasDaum: false };
    const kind = routeKind(row.url);
    if (kind === "direct") current.hasDirect = true;
    if (kind === "naver") current.hasNaver = true;
    if (kind === "daum") current.hasDaum = true;
    routes.set(key, current);
  }
  return { urls, routes };
}

export function decodeBigKindsPayload(env: NodeJS.ProcessEnv = process.env): BigKindsPayloadRow[] {
  const count = Number(env.BIGKINDS_IMPORT_CHUNKS || 0);
  if (!Number.isInteger(count) || count < 1 || count > 64) throw new Error("BIGKINDS_IMPORT_CHUNKS is invalid.");
  let encoded = "";
  for (let index = 0; index < count; index++) {
    const name = `BIGKINDS_IMPORT_${String(index).padStart(2, "0")}`;
    const chunk = env[name];
    if (!chunk) throw new Error(`${name} is missing.`);
    encoded += chunk;
  }
  if (encoded.length > 5_000_000) throw new Error("Configured BigKinds payload is too large.");
  const parsed = JSON.parse(gunzipSync(Buffer.from(encoded, "base64")).toString("utf8")) as unknown;
  if (!Array.isArray(parsed) || parsed.length > 20_000) throw new Error("Configured BigKinds payload rows are invalid.");
  return parsed.map((value, index) => {
    if (!value || typeof value !== "object") throw new Error(`Payload row ${index + 1} is invalid.`);
    const row = value as Record<string, unknown>;
    const normalized: BigKindsPayloadRow = {
      i: String(row.i ?? "").trim().slice(0, 300),
      d: String(row.d ?? "").trim().slice(0, 20),
      m: String(row.m ?? "").trim().slice(0, 300),
      t: String(row.t ?? "").trim().slice(0, 1000),
      c: String(row.c ?? "").trim().slice(0, 3000),
      u: String(row.u ?? "").trim().slice(0, 3000),
    };
    if (!normalized.d || !normalized.m || !normalized.t) throw new Error(`Payload row ${index + 1} lacks date, media or title.`);
    return normalized;
  });
}

async function payloadWorkbook(rows: BigKindsPayloadRow[]): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("뉴스");
  sheet.addRow(["뉴스 식별자", "일자", "언론사", "제목", "본문", "URL"]);
  for (const row of rows) sheet.addRow([row.i, row.d, row.m, row.t, row.c, row.u]);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

async function loadExistingRows(): Promise<ExistingRow[]> {
  return await db.select({
    url: articlesTable.url,
    title: articlesTable.title,
    mediaName: articlesTable.mediaName,
    publishedAt: articlesTable.publishedAt,
  }).from(articlesTable);
}

function matchedNaverItems(row: BigKindsPayloadRow, items: NaverItem[]): Array<{ item: NaverItem; publishedAt: Date }> {
  const expected = parseBigKindsDate(row.d);
  if (!expected) return [];
  const expectedMedia = normalizedMedia(row.m);
  return items.flatMap((item) => {
    const title = stripHtml(item.title || "");
    const publishedAt = new Date(item.pubDate || "");
    if (!title || !Number.isFinite(publishedAt.getTime())) return [];
    if (!titlesEquivalent(row.t, title) || dayDistance(expected, publishedAt) > 1) return [];
    const mapped = resolveMediaNameStrict(item.originallink || item.link || "");
    if (mapped && normalizedMedia(mapped) !== expectedMedia && normalizedTitle(row.t) !== normalizedTitle(title)) return [];
    return [{ item, publishedAt }];
  });
}

async function fetchNaver(row: BigKindsPayloadRow): Promise<NaverItem[]> {
  const clientId = process.env.NAVER_CLIENT_ID;
  const clientSecret = process.env.NAVER_CLIENT_SECRET;
  if (!clientId || !clientSecret) return [];
  const query = row.t.replace(/\s+/g, " ").trim().slice(0, 180);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await axios.get<{ items?: NaverItem[] }>("https://openapi.naver.com/v1/search/news.json", {
        params: { query, display: 20, start: 1, sort: "date" },
        headers: { "X-Naver-Client-Id": clientId, "X-Naver-Client-Secret": clientSecret },
        timeout: 15_000,
      });
      return response.data.items || [];
    } catch (error) {
      const status = (error as { response?: { status?: number } }).response?.status;
      if ((status === 429 || (status != null && status >= 500)) && attempt === 0) {
        await wait(status === 429 ? 60_000 : 5_000);
        continue;
      }
      throw error;
    }
  }
  return [];
}

async function fetchKakao(row: BigKindsPayloadRow): Promise<KakaoDocument[]> {
  const key = process.env.KAKAO_REST_API_KEY;
  if (!key) return [];
  const query = `${row.t} ${row.m}`.replace(/\s+/g, " ").trim().slice(0, 300);
  const response = await axios.get<{ documents?: KakaoDocument[] }>("https://dapi.kakao.com/v2/search/web", {
    params: { query, size: 10, page: 1, sort: "recency" },
    headers: { Authorization: `KakaoAK ${key}` },
    timeout: 15_000,
  });
  return response.data.documents || [];
}

function matchedKakaoDocuments(row: BigKindsPayloadRow, documents: KakaoDocument[]): Array<{ document: KakaoDocument; publishedAt: Date }> {
  const expected = parseBigKindsDate(row.d);
  if (!expected) return [];
  const expectedMedia = normalizedMedia(row.m);
  return documents.flatMap((document) => {
    const title = stripHtml(document.title || "");
    const publishedAt = new Date(document.datetime || "");
    const url = document.url || "";
    if (!title || !isValidUrl(url)) return [];
    if (!titlesEquivalent(row.t, title)) return [];
    if (Number.isFinite(publishedAt.getTime()) && dayDistance(expected, publishedAt) > 1) return [];
    const mapped = resolveMediaNameStrict(url);
    if (mapped && normalizedMedia(mapped) !== expectedMedia && normalizedTitle(row.t) !== normalizedTitle(title)) return [];
    return [{ document, publishedAt: Number.isFinite(publishedAt.getTime()) ? publishedAt : expected }];
  });
}

async function insertRoutes(
  rows: Array<{ url: string; title: string; content: string; publishedAt: Date; mediaName: string; source: string }>,
): Promise<number> {
  if (!rows.length) return 0;
  const inserted = await db.insert(articlesTable).values(rows.map((row) => ({
    ...row,
    isNegative: false,
    isSelfPR: false,
  }))).onConflictDoNothing().returning({ id: articlesTable.id });
  return inserted.length;
}

async function saveProgress(key: string, state: BackfillState): Promise<void> {
  state.updatedAt = new Date().toISOString();
  await writeState(key, state);
}

async function enrichWithNaver(rows: BigKindsPayloadRow[], stateKey: string, state: BackfillState): Promise<void> {
  if (!process.env.NAVER_CLIENT_ID || !process.env.NAVER_CLIENT_SECRET) {
    state.note = "Naver API credentials are not configured; BigKinds import completed without Naver alternate-route enrichment.";
    return;
  }
  const existing = await loadExistingRows();
  const index = buildIndexes(existing);
  const start = Math.max(0, state.naverIndex || 0);
  for (let rowIndex = start; rowIndex < rows.length; rowIndex++) {
    const row = rows[rowIndex]!;
    const date = parseBigKindsDate(row.d);
    if (!date) {
      state.naverFailures = (state.naverFailures || 0) + 1;
      state.naverIndex = rowIndex + 1;
      continue;
    }
    const key = storyKey({ title: row.t, mediaName: row.m, publishedAt: date });
    const route = index.routes.get(key) ?? { hasDirect: false, hasNaver: false, hasDaum: false };
    if (!(route.hasDirect && route.hasNaver)) {
      try {
        const matches = matchedNaverItems(row, await fetchNaver(row));
        state.naverQueries = (state.naverQueries || 0) + 1;
        if (matches.length) state.naverMatches = (state.naverMatches || 0) + 1;
        const pending: Array<{ url: string; title: string; content: string; publishedAt: Date; mediaName: string; source: string }> = [];
        for (const { item, publishedAt } of matches.slice(0, 3)) {
          for (const raw of [item.originallink, item.link]) {
            if (!raw || !isValidUrl(raw)) continue;
            const url = new URL(raw); url.hash = "";
            const value = url.toString();
            const urlKey = canonicalUrl(value);
            if (index.urls.has(urlKey)) continue;
            const kind = routeKind(value);
            pending.push({
              url: value,
              title: row.t,
              content: row.c || stripHtml(item.description || ""),
              publishedAt,
              mediaName: row.m,
              source: kind === "naver" ? "naver_title_portal" : "naver_title_original",
            });
            index.urls.add(urlKey);
            if (kind === "naver") route.hasNaver = true;
            if (kind === "direct") route.hasDirect = true;
          }
          if (route.hasDirect && route.hasNaver) break;
        }
        const inserted = await insertRoutes(pending);
        state.naverInserted = (state.naverInserted || 0) + inserted;
        index.routes.set(key, route);
      } catch (error) {
        const status = (error as { response?: { status?: number } }).response?.status;
        state.naverFailures = (state.naverFailures || 0) + 1;
        logger.warn({ rowIndex, title: row.t, status, error: error instanceof Error ? error.message : String(error) }, "Naver title-route lookup failed");
        if (status === 401 || status === 403) {
          state.note = `Naver alternate-route enrichment stopped on HTTP ${status}.`;
          state.naverIndex = rowIndex;
          await saveProgress(stateKey, state);
          return;
        }
      }
      await wait(180);
    }
    state.naverIndex = rowIndex + 1;
    if ((rowIndex + 1) % 25 === 0) {
      await saveProgress(stateKey, state);
      logger.info({
        processed: rowIndex + 1,
        total: rows.length,
        queries: state.naverQueries || 0,
        matches: state.naverMatches || 0,
        inserted: state.naverInserted || 0,
        failures: state.naverFailures || 0,
      }, "BigKinds Naver alternate-route progress");
    }
  }
}

async function enrichUnresolvedWithKakao(rows: BigKindsPayloadRow[], stateKey: string, state: BackfillState): Promise<void> {
  if (!process.env.KAKAO_REST_API_KEY) return;
  const existing = await loadExistingRows();
  const index = buildIndexes(existing);
  const unresolved = rows.filter((row) => {
    const date = parseBigKindsDate(row.d);
    if (!date) return false;
    const route = index.routes.get(storyKey({ title: row.t, mediaName: row.m, publishedAt: date }));
    return !route?.hasDirect;
  });
  const start = Math.max(0, state.kakaoIndex || 0);
  for (let rowIndex = start; rowIndex < unresolved.length; rowIndex++) {
    const row = unresolved[rowIndex]!;
    const date = parseBigKindsDate(row.d);
    if (!date) continue;
    const key = storyKey({ title: row.t, mediaName: row.m, publishedAt: date });
    const route = index.routes.get(key) ?? { hasDirect: false, hasNaver: false, hasDaum: false };
    if (!route.hasDirect) {
      try {
        const matches = matchedKakaoDocuments(row, await fetchKakao(row));
        state.kakaoQueries = (state.kakaoQueries || 0) + 1;
        if (matches.length) state.kakaoMatches = (state.kakaoMatches || 0) + 1;
        const pending: Array<{ url: string; title: string; content: string; publishedAt: Date; mediaName: string; source: string }> = [];
        for (const { document, publishedAt } of matches.slice(0, 3)) {
          const raw = document.url || "";
          if (!isValidUrl(raw)) continue;
          const url = new URL(raw); url.hash = "";
          const value = url.toString();
          const urlKey = canonicalUrl(value);
          if (index.urls.has(urlKey)) continue;
          const kind = routeKind(value);
          pending.push({
            url: value,
            title: row.t,
            content: row.c || stripHtml(document.contents || ""),
            publishedAt,
            mediaName: row.m,
            source: kind === "daum" ? "kakao_title_daum" : "kakao_title_original",
          });
          index.urls.add(urlKey);
          if (kind === "direct") route.hasDirect = true;
          if (kind === "daum") route.hasDaum = true;
          if (route.hasDirect) break;
        }
        const inserted = await insertRoutes(pending);
        state.kakaoInserted = (state.kakaoInserted || 0) + inserted;
        index.routes.set(key, route);
      } catch (error) {
        const status = (error as { response?: { status?: number } }).response?.status;
        state.kakaoFailures = (state.kakaoFailures || 0) + 1;
        logger.warn({ rowIndex, title: row.t, status, error: error instanceof Error ? error.message : String(error) }, "Kakao title-route lookup failed");
        if (status === 401 || status === 403 || status === 429) {
          state.note = `Kakao unresolved-route enrichment stopped on HTTP ${status}.`;
          state.kakaoIndex = rowIndex;
          await saveProgress(stateKey, state);
          return;
        }
      }
      await wait(220);
    }
    state.kakaoIndex = rowIndex + 1;
    if ((rowIndex + 1) % 20 === 0) await saveProgress(stateKey, state);
  }
}

export async function startConfiguredBigKindsBackfill(): Promise<void> {
  const importKey = process.env.BIGKINDS_IMPORT_KEY?.trim();
  if (!importKey || !process.env.BIGKINDS_IMPORT_CHUNKS) return;
  const stateKey = `bigkinds-backfill:${importKey}`;
  const client = await pool.connect();
  try {
    const lock = await client.query<{ locked: boolean }>("SELECT pg_try_advisory_lock(hashtext($1)) AS locked", [stateKey]);
    if (!lock.rows[0]?.locked) {
      logger.info({ importKey }, "BigKinds backfill is already running on another instance");
      return;
    }
    const state = await readState<BackfillState>(stateKey) || {};
    if (state.completedAt) {
      logger.info({ importKey, completedAt: state.completedAt }, "Configured BigKinds backfill already completed");
      return;
    }
    const rows = decodeBigKindsPayload();
    logger.info({ importKey, rows: rows.length, resumedAt: state.naverIndex || 0 }, "Configured BigKinds backfill started");

    if (!state.importDone) {
      const summary = await importBigKindsWorkbook(await payloadWorkbook(rows));
      const counts = {
        total: summary.total,
        inserted: summary.inserted,
        duplicates: summary.duplicates,
        irrelevant: summary.irrelevant,
        failed: summary.failed,
      };
      state.importDone = true;
      state.importSummary = counts;
      await saveProgress(stateKey, state);
      logger.info({ importKey, ...counts }, "BigKinds workbook payload imported");
    }

    await enrichWithNaver(rows, stateKey, state);
    await saveProgress(stateKey, state);
    await enrichUnresolvedWithKakao(rows, stateKey, state);
    state.completedAt = new Date().toISOString();
    await saveProgress(stateKey, state);
    logger.info({
      importKey,
      importSummary: state.importSummary,
      naverQueries: state.naverQueries || 0,
      naverMatches: state.naverMatches || 0,
      naverInserted: state.naverInserted || 0,
      naverFailures: state.naverFailures || 0,
      kakaoQueries: state.kakaoQueries || 0,
      kakaoMatches: state.kakaoMatches || 0,
      kakaoInserted: state.kakaoInserted || 0,
      kakaoFailures: state.kakaoFailures || 0,
      note: state.note,
    }, "Configured BigKinds backfill completed");
  } finally {
    await client.query("SELECT pg_advisory_unlock(hashtext($1))", [stateKey]).catch(() => {});
    client.release();
  }
}

import { createHash } from "node:crypto";
import ExcelJS from "exceljs";
import { db, articlesTable } from "@workspace/db";
import { isNull } from "drizzle-orm";
import { mapInPacedBatches } from "./crawlPacing";
import { extractPressName, resolveMediaNameStrict, type ArticleData } from "./crawlerUtils";
import { isRelevant } from "./newsRelevance";
import { resolveArticleContent } from "./publisherResolver";
import { trashKey } from "./existingArticles";

export type ImportItemStatus = "inserted" | "duplicate" | "irrelevant" | "failed";

export interface ImportItemResult {
  input: string;
  status: ImportItemStatus;
  title?: string;
  url?: string;
  reason?: string;
}

export interface ImportSummary {
  total: number;
  inserted: number;
  duplicates: number;
  irrelevant: number;
  failed: number;
  results: ImportItemResult[];
  metadata?: Record<string, unknown>;
}

interface CandidateRow {
  input: string;
  article: ArticleData;
}

function kstDay(date: Date): string {
  return new Date(date.getTime() + 9 * 3600_000).toISOString().slice(0, 10);
}

function normalizedTitle(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
}

function urlKey(raw: string): string {
  return /^https?:\/\//i.test(raw) ? trashKey(raw) : raw.trim().toLowerCase();
}

function storyKey(article: Pick<ArticleData, "title" | "mediaName" | "publishedAt">): string {
  return JSON.stringify([
    extractPressName(article.mediaName).normalize("NFKC").toLowerCase().replace(/\s+/g, ""),
    kstDay(article.publishedAt),
    normalizedTitle(article.title),
  ]);
}

async function importDedupe(database: typeof db) {
  const rows = await database.select({
    url: articlesTable.url,
    title: articlesTable.title,
    mediaName: articlesTable.mediaName,
    publishedAt: articlesTable.publishedAt,
  }).from(articlesTable);
  const urls = new Set(rows.map((row) => urlKey(row.url)));
  const stories = new Set(rows.map((row) => storyKey(row)));
  return {
    has(article: ArticleData): boolean {
      return urls.has(urlKey(article.url)) || stories.has(storyKey(article));
    },
    remember(article: ArticleData): void {
      urls.add(urlKey(article.url));
      stories.add(storyKey(article));
    },
  };
}

function summarize(results: ImportItemResult[], metadata?: Record<string, unknown>): ImportSummary {
  const count = (status: ImportItemStatus) => results.filter((item) => item.status === status).length;
  return {
    total: results.length,
    inserted: count("inserted"),
    duplicates: count("duplicate"),
    irrelevant: count("irrelevant"),
    failed: count("failed"),
    results,
    metadata,
  };
}

async function saveCandidates(
  candidates: CandidateRow[],
  initial: ImportItemResult[],
  database: typeof db,
): Promise<ImportSummary> {
  const dedupe = await importDedupe(database);
  const results = [...initial];
  const pending: CandidateRow[] = [];

  for (const candidate of candidates) {
    if (dedupe.has(candidate.article)) {
      results.push({ input: candidate.input, status: "duplicate", title: candidate.article.title, url: candidate.article.url });
      continue;
    }
    dedupe.remember(candidate.article);
    pending.push(candidate);
  }

  for (let offset = 0; offset < pending.length; offset += 200) {
    const batch = pending.slice(offset, offset + 200);
    const inserted = await database.insert(articlesTable).values(batch.map(({ article }) => ({
      title: article.title,
      content: article.content,
      url: article.url,
      publishedAt: article.publishedAt,
      mediaName: article.mediaName,
      isNegative: article.isNegative,
      isSelfPR: article.isSelfPR,
      source: article.source,
    }))).onConflictDoNothing().returning({ url: articlesTable.url, source: articlesTable.source });
    const keys = new Set(inserted.map((row) => JSON.stringify([row.source, row.url])));
    for (const candidate of batch) {
      const stored = keys.has(JSON.stringify([candidate.article.source, candidate.article.url]));
      results.push({
        input: candidate.input,
        status: stored ? "inserted" : "duplicate",
        title: candidate.article.title,
        url: candidate.article.url,
      });
    }
  }

  return summarize(results);
}

export function parseUrlText(text: string): { urls: string[]; invalid: ImportItemResult[] } {
  const urls: string[] = [];
  const invalid: ImportItemResult[] = [];
  const seen = new Set<string>();
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const match = line.match(/https?:\/\/[^\s<>"']+/i);
    if (!match) {
      invalid.push({ input: line, status: "failed", reason: "http 또는 https 기사 주소를 찾지 못했습니다." });
      continue;
    }
    try {
      const url = new URL(match[0]);
      url.hash = "";
      const value = url.toString();
      if (!seen.has(value)) { seen.add(value); urls.push(value); }
    } catch {
      invalid.push({ input: line, status: "failed", reason: "올바른 URL이 아닙니다." });
    }
  }
  return { urls, invalid };
}

export async function importArticleUrls(
  text: string,
  database: typeof db = db,
): Promise<ImportSummary> {
  const parsed = parseUrlText(text);
  if (parsed.urls.length > 100) throw new Error("URL은 한 번에 최대 100개까지 가져올 수 있습니다.");

  const inspected = await mapInPacedBatches(
    parsed.urls,
    async (input): Promise<CandidateRow | ImportItemResult> => {
      const identity = await resolveArticleContent(input, { maxRequests: 6 });
      const title = identity.articleTitle?.trim();
      const publishedAt = identity.publishedAt ? new Date(identity.publishedAt) : null;
      const originalUrl = /^https?:\/\//i.test(identity.originalUrl) ? identity.originalUrl : input;
      if (!title) return { input, status: "failed", reason: `기사 제목을 확인하지 못했습니다. (${identity.evidence.join(", ") || "메타데이터 없음"})` };
      if (!publishedAt || !Number.isFinite(publishedAt.getTime())) return { input, status: "failed", title, reason: "기사 게시일을 확인하지 못했습니다." };
      const content = identity.articleText?.trim() || "";
      if (!isRelevant(title, content)) return { input, status: "irrelevant", title, url: originalUrl, reason: "제목과 확인 가능한 본문에서 노들섬 관련 키워드를 찾지 못했습니다." };
      const publisher = identity.publisher || resolveMediaNameStrict(originalUrl) || resolveMediaNameStrict(input) || "기타";
      return {
        input,
        article: {
          title,
          content,
          url: originalUrl,
          publishedAt,
          mediaName: publisher,
          isNegative: false,
          isSelfPR: false,
          source: "manual_url_import",
        },
      };
    },
    { batchSize: 4, concurrency: 2, pauseMinMs: 700, pauseMaxMs: 1300 },
  );

  const failures = [...parsed.invalid];
  const candidates: CandidateRow[] = [];
  for (const result of inspected) {
    if ("article" in result) candidates.push(result);
    else failures.push(result);
  }
  return saveCandidates(candidates, failures, database);
}

function cellText(value: unknown): string {
  if (value == null) return "";
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value).trim();
  if (typeof value === "object") {
    const object = value as Record<string, unknown>;
    if (typeof object.text === "string") return object.text.trim();
    if (typeof object.hyperlink === "string") return object.hyperlink.trim();
    if (Array.isArray(object.richText)) return object.richText.map((part) => cellText(part)).join("").trim();
    if (object.result != null) return cellText(object.result);
  }
  return String(value).trim();
}

function cellUrl(value: unknown): string {
  if (value && typeof value === "object" && typeof (value as Record<string, unknown>).hyperlink === "string") {
    return String((value as Record<string, unknown>).hyperlink).trim();
  }
  return cellText(value);
}

function normalizeHeader(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/[\s_\-()[\]{}·:/.]/g, "");
}

const HEADER_ALIASES = {
  id: ["뉴스식별자", "뉴스id", "식별자"],
  date: ["일자", "날짜", "발행일", "작성일", "기사일자"],
  media: ["언론사", "언론사명", "매체", "매체명"],
  title: ["제목", "기사제목", "뉴스제목"],
  content: ["본문", "내용", "기사본문", "뉴스본문"],
  url: ["url", "원문url", "기사url", "원문링크", "기사링크", "링크", "주소"],
  keywords: ["키워드", "특성추출", "특성추출가중치순상위50개", "검색어"],
} as const;

type HeaderKey = keyof typeof HEADER_ALIASES;

function findColumn(headers: Map<string, number>, key: HeaderKey): number | undefined {
  const aliases = HEADER_ALIASES[key].map(normalizeHeader);
  for (const alias of aliases) if (headers.has(alias)) return headers.get(alias);
  for (const [header, column] of headers) if (aliases.some((alias) => header.includes(alias) || alias.includes(header))) return column;
  return undefined;
}

function parseSheetDate(value: unknown): Date | null {
  let day = "";
  if (value instanceof Date && Number.isFinite(value.getTime())) day = value.toISOString().slice(0, 10);
  else if (typeof value === "number" && Number.isFinite(value)) {
    day = new Date(Math.round((value - 25569) * 86400_000)).toISOString().slice(0, 10);
  } else {
    const text = cellText(value);
    const compact = text.match(/^(\d{4})(\d{2})(\d{2})(?:\d{6})?$/);
    const separated = text.match(/^(\d{4})[-./](\d{1,2})[-./](\d{1,2})/);
    if (compact) day = `${compact[1]}-${compact[2]}-${compact[3]}`;
    else if (separated) day = `${separated[1]}-${separated[2]!.padStart(2, "0")}-${separated[3]!.padStart(2, "0")}`;
    else {
      const parsed = new Date(text);
      if (Number.isFinite(parsed.getTime())) day = parsed.toISOString().slice(0, 10);
    }
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const date = new Date(`${day}T12:00:00+09:00`);
  return Number.isFinite(date.getTime()) && kstDay(date) === day ? date : null;
}

function internalBigKindsUrl(id: string, media: string, date: Date, title: string): string {
  if (id) return `bigkinds:${encodeURIComponent(id)}`;
  const hash = createHash("sha256").update(`${media}\u0000${kstDay(date)}\u0000${title}`).digest("hex").slice(0, 32);
  return `bigkinds:sha256:${hash}`;
}

export async function importBigKindsWorkbook(
  buffer: Buffer,
  database: typeof db = db,
): Promise<ImportSummary> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as never);
  const worksheet = workbook.worksheets.find((sheet) => sheet.actualRowCount > 0);
  if (!worksheet) throw new Error("엑셀 파일에서 데이터 시트를 찾지 못했습니다.");

  let headerRow = 0;
  let columns: Partial<Record<HeaderKey, number>> = {};
  for (let rowNumber = 1; rowNumber <= Math.min(10, worksheet.actualRowCount); rowNumber++) {
    const row = worksheet.getRow(rowNumber);
    const headers = new Map<string, number>();
    row.eachCell({ includeEmpty: false }, (cell, column) => {
      const normalized = normalizeHeader(cellText(cell.value));
      if (normalized) headers.set(normalized, column);
    });
    const candidate = Object.fromEntries((Object.keys(HEADER_ALIASES) as HeaderKey[]).map((key) => [key, findColumn(headers, key)])) as Partial<Record<HeaderKey, number>>;
    if (candidate.title && candidate.date && candidate.media) {
      headerRow = rowNumber;
      columns = candidate;
      break;
    }
  }
  if (!headerRow || !columns.title || !columns.date || !columns.media) {
    throw new Error("빅카인즈 열을 찾지 못했습니다. 최소한 '일자·언론사·제목' 열이 필요합니다.");
  }

  const availableRows = worksheet.actualRowCount - headerRow;
  if (availableRows > 20_000) throw new Error("한 번에 최대 20,000행까지 가져올 수 있습니다.");

  const candidates: CandidateRow[] = [];
  const failures: ImportItemResult[] = [];
  for (let rowNumber = headerRow + 1; rowNumber <= worksheet.actualRowCount; rowNumber++) {
    const row = worksheet.getRow(rowNumber);
    const title = cellText(row.getCell(columns.title).value);
    const mediaName = cellText(row.getCell(columns.media).value);
    const date = parseSheetDate(row.getCell(columns.date).value);
    const id = columns.id ? cellText(row.getCell(columns.id).value) : "";
    const body = columns.content ? cellText(row.getCell(columns.content).value) : "";
    const keywords = columns.keywords ? cellText(row.getCell(columns.keywords).value) : "";
    const suppliedUrl = columns.url ? cellUrl(row.getCell(columns.url).value) : "";
    const input = id || suppliedUrl || `행 ${rowNumber}`;
    if (!title && !mediaName && !date) continue;
    if (!title || !mediaName || !date) {
      failures.push({ input, status: "failed", title: title || undefined, reason: "일자·언론사·제목 중 하나가 비어 있습니다." });
      continue;
    }
    const content = [body, keywords ? `키워드: ${keywords}` : ""].filter(Boolean).join("\n");
    if (!isRelevant(title, content)) {
      failures.push({ input, status: "irrelevant", title, reason: "제목·본문·키워드에서 노들섬 관련 키워드를 찾지 못했습니다." });
      continue;
    }
    let url = suppliedUrl;
    try {
      if (url) {
        const parsed = new URL(url);
        if (!["http:", "https:"].includes(parsed.protocol)) url = "";
        else { parsed.hash = ""; url = parsed.toString(); }
      }
    } catch { url = ""; }
    if (!url) url = internalBigKindsUrl(id, mediaName, date, title);
    candidates.push({
      input,
      article: {
        title,
        content,
        url,
        publishedAt: date,
        mediaName,
        isNegative: false,
        isSelfPR: false,
        source: "bigkinds_import",
      },
    });
  }

  const summary = await saveCandidates(candidates, failures, database);
  return {
    ...summary,
    metadata: {
      sheet: worksheet.name,
      headerRow,
      rows: availableRows,
      mappedColumns: Object.fromEntries(Object.entries(columns).filter(([, value]) => value != null)),
      urlNote: columns.url ? "URL 열을 사용했습니다." : "URL 열이 없어 뉴스 식별자 기반 내부 키를 사용했습니다.",
    },
  };
}

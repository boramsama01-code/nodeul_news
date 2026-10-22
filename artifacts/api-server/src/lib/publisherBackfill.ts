import { resolveArticleIdentity } from "./publisherResolver";
import * as cheerio from "cheerio";
import { extractPressName, resolveMediaNameStrict, stripHtml, type ArticleData } from "./crawlerUtils";
import { logger } from "./logger";
import { mapInPacedBatches, sleepWithJitter } from "./crawlPacing";
import { writeState } from "./persistentState";

export interface PublisherResolution {
  publisher?: string;
  finalUrl: string;
  canonicalUrl?: string;
  evidence?: string;
}

const GENERIC_NAMES = new Set([
  "", "기타", "알수없음", "알 수 없음", "네이버", "네이버뉴스", "naver", "naver news",
  "다음", "다음뉴스", "daum", "daum news", "카카오", "kakao", "구글뉴스", "google news",
  "뉴스", "news", "언론사", "publisher", "media",
]);
function namesFromValue(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(namesFromValue);
  if (!value || typeof value !== "object") return [];
  const object = value as Record<string, unknown>;
  return [object.name, object.legalName, object.alternateName].flatMap(namesFromValue);
}

function jsonLdPublisherNames(value: unknown, depth = 0): string[] {
  if (depth > 8 || value == null) return [];
  if (Array.isArray(value)) return value.flatMap((entry) => jsonLdPublisherNames(entry, depth + 1));
  if (typeof value !== "object") return [];
  const object = value as Record<string, unknown>;
  const names: string[] = [];
  for (const key of ["publisher", "sourceOrganization", "copyrightHolder", "provider", "isPartOf"]) {
    names.push(...namesFromValue(object[key]));
  }
  const type = namesFromValue(object["@type"]).join(" ").toLowerCase();
  if (/(newsmediaorganization|organization|newsorganization)/.test(type)) names.push(...namesFromValue(object));
  for (const child of Object.values(object)) names.push(...jsonLdPublisherNames(child, depth + 1));
  return names;
}

function cleanPublisherCandidate(raw: string): string | undefined {
  let value = stripHtml(raw).replace(/\s+/g, " ").trim();
  value = value.replace(/^[|·•\-–—\s]+|[|·•\-–—\s]+$/g, "");
  value = value.replace(/\s*[|｜]\s*(네이버뉴스|다음뉴스|Google News)$/i, "").trim();
  if (value.length < 2 || value.length > 80 || /^https?:\/\//i.test(value) || value.startsWith("@")) return undefined;
  if (GENERIC_NAMES.has(value.toLowerCase())) return undefined;
  const aliases: Record<string, string> = {
    "yonhap news agency": "연합뉴스", "news1": "뉴스1", "newsis": "뉴시스",
    "kbs 뉴스": "KBS", "kbs news": "KBS", "mbc news": "MBC", "sbs 뉴스": "SBS", "sbs news": "SBS",
    "jtbc news": "JTBC", "the korea herald": "코리아헤럴드", "the korea times": "코리아타임스",
  };
  return aliases[value.toLowerCase()] ?? value;
}

export function extractPublisherFromHtml(html: string, pageUrl: string): PublisherResolution {
  const $ = cheerio.load(html);
  const canonicalRaw = $('link[rel="canonical"]').attr("href")?.trim();
  let canonicalUrl: string | undefined;
  if (canonicalRaw) {
    try { canonicalUrl = new URL(canonicalRaw, pageUrl).toString(); } catch { /* malformed canonical */ }
  }

  for (const candidateUrl of [canonicalUrl, pageUrl]) {
    if (!candidateUrl) continue;
    const fromDomain = resolveMediaNameStrict(candidateUrl);
    if (fromDomain && !GENERIC_NAMES.has(fromDomain.toLowerCase())) {
      return { publisher: fromDomain, finalUrl: pageUrl, canonicalUrl, evidence: "domain" };
    }
  }

  const candidates: Array<{ value: string; evidence: string }> = [];
  const selectors = [
    'meta[property="og:site_name"]', 'meta[name="application-name"]', 'meta[name="publisher"]',
    'meta[itemprop="publisher"]', 'meta[property="article:publisher"]', 'meta[name="twitter:site:name"]',
  ];
  for (const selector of selectors) {
    $(selector).each((_, element) => {
      const value = $(element).attr("content")?.trim();
      if (value) candidates.push({ value, evidence: selector });
    });
  }
  $('script[type="application/ld+json"]').each((_, element) => {
    const raw = $(element).text().trim();
    if (!raw) return;
    try {
      for (const value of jsonLdPublisherNames(JSON.parse(raw))) candidates.push({ value, evidence: "json-ld" });
    } catch { /* invalid JSON-LD is common */ }
  });

  for (const candidate of candidates) {
    const publisher = cleanPublisherCandidate(candidate.value);
    if (publisher) return { publisher, finalUrl: pageUrl, canonicalUrl, evidence: candidate.evidence };
  }
  return { finalUrl: pageUrl, canonicalUrl };
}

export function isUnknownPublisher(mediaName: string): boolean {
  const press = extractPressName(mediaName).trim().toLowerCase();
  return GENERIC_NAMES.has(press) || /\((기타|알수없음|알 수 없음)\)$/.test(mediaName);
}

export function formatResolvedMediaName(existing: string, publisher: string): string {
  const parenthesized = existing.match(/^(.+?)\((?:기타|알수없음|알 수 없음)\)$/);
  if (parenthesized) return `${parenthesized[1]}(${publisher})`;
  if (/^네이버(뉴스)?$/i.test(existing)) return `네이버(${publisher})`;
  if (/^다음(뉴스)?$/i.test(existing)) return `다음뉴스(${publisher})`;
  if (/^구글(뉴스)?$/i.test(existing)) return `구글뉴스(${publisher})`;
  return publisher;
}

export async function resolvePublisherFromUrl(url: string): Promise<PublisherResolution> {
  const value = await resolveArticleIdentity(url);
  return {publisher:value.publisher || undefined, finalUrl:value.originalUrl, evidence:value.evidence.join(", ")};
}

export async function enrichArticlePublisher(article: ArticleData): Promise<ArticleData> {
  if (!isUnknownPublisher(article.mediaName)) return article;
  const resolved = await resolvePublisherFromUrl(article.url);
  if (!resolved.publisher) return article;
  return { ...article, mediaName: formatResolvedMediaName(article.mediaName, resolved.publisher) };
}

export async function backfillUnknownPublishers(
  startDate: string,
  endDate: string,
  options: { batchSize?: number; maxRows?: number } = {},
): Promise<{ scanned: number; resolved: number; unresolved: number; errors: number }> {
  const { pool } = await import("@workspace/db");
  const batchSize = Math.max(1, Math.min(50, options.batchSize ?? 16));
  const maxRows = Math.max(batchSize, options.maxRows ?? 3000);
  let lastId = 0;
  let scanned = 0;
  let resolved = 0;
  let unresolved = 0;
  let errors = 0;

  while (scanned < maxRows) {
    const result = await pool.query<{ id: number; url: string; media_name: string }>(
      `SELECT id,url,media_name FROM articles
       WHERE id > $1 AND deleted_at IS NULL
         AND published_at >= $2::date AND published_at < ($3::date + interval '1 day')
         AND (media_name IN ('기타','알수없음','알 수 없음','네이버뉴스','다음뉴스','구글뉴스')
              OR media_name LIKE '%(기타)' OR media_name LIKE '%(알수없음)' OR media_name LIKE '%(알 수 없음)')
       ORDER BY id LIMIT $4`,
      [lastId, startDate, endDate, Math.min(batchSize, maxRows - scanned)],
    );
    if (result.rows.length === 0) break;
    lastId = result.rows[result.rows.length - 1]!.id;
    scanned += result.rows.length;

    const outcomes = await mapInPacedBatches(result.rows, async (row) => {
      try {
        const metadata = await resolvePublisherFromUrl(row.url);
        if (!metadata.publisher) return "unresolved" as const;
        const next = formatResolvedMediaName(row.media_name, metadata.publisher);
        const updated = await pool.query(
          "UPDATE articles SET media_name=$1 WHERE id=$2 AND media_name=$3 AND deleted_at IS NULL",
          [next, row.id, row.media_name],
        );
        return updated.rowCount ? "resolved" as const : "unresolved" as const;
      } catch (error) {
        logger.warn({ id: row.id, error: error instanceof Error ? error.message : String(error) }, "Publisher backfill row failed");
        return "error" as const;
      }
    }, { batchSize: 4, concurrency: 2, pauseMinMs: 1800, pauseMaxMs: 3200 });

    for (const outcome of outcomes) {
      if (outcome === "resolved") resolved++;
      else if (outcome === "unresolved") unresolved++;
      else errors++;
    }
    logger.info({ scanned, resolved, unresolved, errors, lastId }, "Publisher backfill batch complete");
    await sleepWithJitter(2200, 4200);
  }

  const summary = { scanned, resolved, unresolved, errors };
  try {
    await writeState("publisher-backfill-latest", { ...summary, startDate, endDate, completedAt: new Date().toISOString() });
  } catch { /* local deployments may not use the app_state table */ }
  logger.info(summary, "Publisher backfill complete");
  return summary;
}

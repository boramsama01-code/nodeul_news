import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ArticleData } from "./crawlerUtils";
import { classifyRelevance, RELEVANCE_VERSION, type RelevanceDecision } from "./relevance";
import { resolveArticleContent, flushPublisherCache } from "./publisherResolver";
import { readStates, writeState, usesDatabaseState } from "./persistentState";

export interface ReviewRecord {
  article: Omit<ArticleData, "publishedAt"> & {publishedAt: string};
  decision: RelevanceDecision;
  checkedAt: string;
  retryAt: string;
  delivered: boolean;
  originalUrl?: string;
}
export const reviewDirectory = () => join(process.env.DATA_DIR || ".local", "relevance-review");
const key = (article: Pick<ArticleData, "source" | "url">) => createHash("sha256").update(JSON.stringify([article.source, article.url])).digest("hex");
const checkReason = (reason: string) => ({
  "request-budget": "이번 작업의 원문 요청 한도에 도달함",
  "request-timeout": "원문 응답 시간 초과",
  "host-cooldown": "해당 사이트 접근 제한으로 요청 휴식 중",
  "provider-cooldown": "수집처 접근 제한으로 요청 휴식 중",
  "redirect-limit": "원문 이동 횟수 한도에 도달함",
  "redirect-loop": "원문 주소가 반복 이동함",
  "non-html": "기사 본문 형식이 아닌 응답",
}[reason] || reason);

export async function readRelevanceReviews(directory?: string): Promise<ReviewRecord[]> {
  if (directory === undefined && usesDatabaseState()) {
    return (await readStates<ReviewRecord>("relevance-review:")).sort((a,b) => a.checkedAt.localeCompare(b.checkedAt));
  }
  directory ??= reviewDirectory();
  let names: string[];
  try { names = await readdir(directory); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  // A corrupt journal is an error, not an empty queue that silently loses work.
  const records: ReviewRecord[] = [];
  for (const name of names.filter(n => /^[a-f0-9]{64}\.json$/.test(n))) {
    records.push(JSON.parse(await readFile(join(directory, name), "utf8")));
  }
  return records.sort((a,b) => a.checkedAt.localeCompare(b.checkedAt));
}

// Writers run under the existing PostgreSQL crawl lock, including worker and
// manual retries. Per-candidate atomic files survive interrupted collection.
export async function createRelevanceReview(options: {
  directory?: string | false;
  maxRequests?: number;
  resolve?: typeof resolveArticleContent;
  now?: () => number;
} = {}) {
  const database = options.directory === undefined && usesDatabaseState();
  const directory = options.directory === false ? false : options.directory || reviewDirectory();
  const records = new Map((database ? await readRelevanceReviews() : directory ? await readRelevanceReviews(directory) : []).map(r => [key(r.article), r]));
  const now = options.now || Date.now;
  const budget = {remaining: options.maxRequests ?? 60};
  const resolve = options.resolve || resolveArticleContent;
  const counts = {related: 0, unrelated: 0, pending: 0};
  async function save(record: ReviewRecord) {
    const id = key(record.article);
    if (database) {
      await writeState(`relevance-review:${id}`, record);
    } else if (directory) {
      await mkdir(directory, {recursive: true});
      const file = join(directory, `${id}.json`), temporary = `${file}.${process.pid}.tmp`;
      await writeFile(temporary, JSON.stringify(record));
      for (let attempt = 0;; attempt++) {
        try { await rename(temporary, file); break; }
        catch (error) {
          if (attempt >= 3 || !["EPERM","EBUSY","EACCES"].includes((error as NodeJS.ErrnoException).code || "")) throw error;
          await new Promise(r => setTimeout(r, 100 * (attempt + 1)));
        }
      }
    }
    records.set(id, record);
  }
  return {
    retryCandidates(start: string, end: string, limit = 80): ArticleData[] {
      const from = Date.parse(`${start}T00:00:00+09:00`), to = Date.parse(`${end}T23:59:59.999+09:00`);
      return [...records.values()].filter(r => {
        const date = Date.parse(r.article.publishedAt);
        return date >= from && date <= to && !r.delivered &&
          (r.decision.version !== RELEVANCE_VERSION || r.decision.status === "related" || (r.decision.status === "pending" && Date.parse(r.retryAt) <= now()));
      }).slice(0, limit).map(r => ({...r.article, publishedAt: new Date(r.article.publishedAt)}));
    },
    async assess(article: ArticleData): Promise<{article: ArticleData; decision: RelevanceDecision}> {
      const previous = records.get(key(article));
      let decision = classifyRelevance(article.title, article.content);
      let checked = article;
      let originalUrl: string | undefined;
      // A fresh explicit positive can resolve an older failed check immediately.
      if (decision.status !== "related" && previous && previous.decision.version === RELEVANCE_VERSION &&
          previous.article.title === article.title && previous.article.content === article.content && Date.parse(previous.retryAt) > now()) {
        counts[previous.decision.status]++;
        return {article: {...previous.article, publishedAt: new Date(previous.article.publishedAt)}, decision: previous.decision};
      }
      if (decision.status !== "related") {
        const result = await resolve(article.url, {budget});
        originalUrl = result.originalUrl;
        if (result.articleText) {
          decision = classifyRelevance(article.title, result.articleText, result.textComplete === true);
          if (decision.status === "related") checked = {...article, content: result.articleText};
        }
        if (decision.status === "pending" && result.evidence.length) decision = {...decision, reason: `${decision.reason} · ${result.evidence.map(checkReason).join(", ")}`};
      }
      counts[decision.status]++;
      await save({article: {...checked, publishedAt: checked.publishedAt.toISOString()}, decision,
        checkedAt: new Date(now()).toISOString(), retryAt: new Date(now() + (decision.status === "pending" ? 6 * 3600_000 : 7 * 86400_000)).toISOString(),
        delivered: previous?.delivered || false, originalUrl});
      return {article: checked, decision};
    },
    async delivered(article: ArticleData) {
      const record = records.get(key(article));
      if (record && !record.delivered) await save({...record, delivered: true});
    },
    summary: () => `관련 확인 ${counts.related}, 무관 확인 ${counts.unrelated}, 확인 대기 ${counts.pending} (대기는 원문 확인 후 재수집)`,
    pendingCount: () => counts.pending,
    flush: () => flushPublisherCache(),
  };
}

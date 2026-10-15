import { extractPressName, cleanPublisherName } from "./crawlerUtils";

export function unidentifiedPublisher(name: string): boolean {
  const press = extractPressName(name || "").trim();
  return !cleanPublisherName(press) || /^구글뉴스-/.test(name) || /^(기타|알수없음|알 수 없음|네이버|네이버뉴스|다음|다음뉴스|구글|구글뉴스|google news|news\.google)$/i.test(press)
    || /^[a-z\d.-]+\.[a-z]{2,}$/i.test(press);
}

export interface MetricArticle { title: string; content?: string | null; url: string; mediaName: string; source: string | null; publishedAt: string | Date; }
function metric(rows: MetricArticle[]) {
  const other = rows.filter(a => /\(기타\)/.test(a.mediaName)).length;
  const unidentified = rows.filter(a => unidentifiedPublisher(a.mediaName)).length;
  const originalUrls = rows.filter(a => {
    try { return !/(^|\.)(naver\.com|daum\.net|google\.com)$/.test(new URL(a.url).hostname); } catch { return false; }
  }).length;
  return { total: rows.length, other, otherRate: rows.length ? other / rows.length : null,
    identified: rows.length - unidentified, identifiedRate: rows.length ? 1 - unidentified / rows.length : null,
    directDomainUrls: originalUrls, directDomainUrlRate: rows.length ? originalUrls / rows.length : null };
}
export function publisherMetrics(rows: MetricArticle[]) {
  const nodeul = rows.filter(a => /노들섬/.test(a.title + " " + (a.content || "")));
  const groups = (items: MetricArticle[]) => Object.fromEntries([...new Set(items.map(a => a.source || ""))].sort().map(source => [source, metric(items.filter(a => (a.source || "") === source))]));
  return { all: metric(rows), bySource: groups(rows), nodeul: metric(nodeul), nodeulBySource: groups(nodeul) };
}

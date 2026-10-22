export type RelevanceStatus = "related" | "unrelated" | "pending";
export interface RelevanceDecision {
  status: RelevanceStatus;
  reason: string;
  evidence: string[];
  version: number;
}
import { isRelevant } from "./newsRelevance";
export const RELEVANCE_VERSION = 2;

const OTHER_PLACES = /노들\s*(?:역|로|남북?\s*고가|고가|나루\s*공원|장애인(?:자립생활)?\s*센터|장애인\s*야학|에스쁘와|강변)|스페이스\s*노들\s*케이/g;
const sentences = (value: string) => value.normalize("NFKC").split(/(?<=[.!?。])\s+|[\r\n]+/).map(s => s.trim()).filter(Boolean);
const excerpt = (text: string, pattern: RegExp) => {
  const at = text.search(pattern);
  return text.slice(Math.max(0, at - 100), Math.max(0, at - 100) + 400);
};

export function hasDiscoveryKeyword(title: string, content: string): boolean {
  return /노들|\bnodeul\b/i.test(`${title} ${content}`.normalize("NFKC"));
}

export function classifyRelevance(title: string, content: string, fullBodyChecked = false): RelevanceDecision {
  const decide = (status: RelevanceStatus, reason: string, evidence: string[] = []): RelevanceDecision =>
    ({ status, reason, evidence, version: RELEVANCE_VERSION });
  const parts = [...sentences(title), ...sentences(content)];
  const explicit = [title, content].find(s => isRelevant(s, ""));
  // Positive island evidence wins even if the same article mentions a station or centre.
  if (explicit) return decide("related", "지정한 노들섬·예술섬 명칭 확인", [excerpt(explicit, /노들/)]);
  if (!fullBodyChecked) return decide("pending", "제목·요약만으로 판단할 수 없어 원문 확인 필요");
  const text = parts.join("\n");
  const others = [...text.matchAll(OTHER_PLACES)].map(m => m[0]);
  const remainder = text.replace(OTHER_PLACES, "");
  if (others.length && !hasDiscoveryKeyword(remainder, "")) {
    return decide("unrelated", "원문에서 노들역·도로·기관 등 다른 대상만 확인", [...new Set(others)].slice(0, 5));
  }
  if (!hasDiscoveryKeyword(text, "")) return decide("unrelated", "확인한 기사 본문에 노들섬 관련 명칭이 없음");
  return decide("pending", "노들 명칭은 있으나 노들섬을 뜻하는지 추가 확인 필요",
    parts.filter(s => hasDiscoveryKeyword(s, "")).slice(0, 3).map(s => excerpt(s, /노들|nodeul/i)));
}

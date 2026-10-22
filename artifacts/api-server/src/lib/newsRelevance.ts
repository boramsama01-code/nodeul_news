export const COLLECTION_KEYWORDS = ["노들섬", "예술섬노들", "글로벌 노들 예술섬", "노들 글로벌 예술섬"] as const;
export const GOOGLE_NEWS_QUERY = COLLECTION_KEYWORDS.map(keyword => `"${keyword}"`).join(" OR ");

export const COMPACT_KEYWORDS = COLLECTION_KEYWORDS.map(keyword => keyword.replace(/\s+/g, ""));

// Match title and collected body/summary separately, allowing spacing variants.
export function isRelevant(title: string, content: string): boolean {
  return [title, content].some(value => {
    const text = value.replace(/\s+/g, "");
    return COMPACT_KEYWORDS.some(keyword => text.includes(keyword));
  });
}

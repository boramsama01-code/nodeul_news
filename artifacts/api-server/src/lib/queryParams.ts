// Query strings carry text. zod's coerce.boolean() turns "false" into true,
// so boolean filters are decided here before validation.
export function strictBoolean(value: unknown): boolean | undefined {
  if (value === true || value === "true") return true;
  if (value === false || value === "false") return false;
  return undefined;
}

export const MAX_PAGE_SIZE = 200;

export function normalizeListQuery(query: Record<string, unknown>): Record<string, unknown> {
  return { ...query, isNegative: strictBoolean(query.isNegative), isSelfPR: strictBoolean(query.isSelfPR) };
}

export function clampPageSize(limit: number | undefined, fallback = 20): number {
  const value = Number.isFinite(limit) ? Math.floor(limit as number) : fallback;
  return Math.min(Math.max(1, value), MAX_PAGE_SIZE);
}

// "네이버(연합뉴스)", "다음뉴스(연합뉴스)", "연합뉴스" → "연합뉴스" for counting.
export const PRESS_NAME_SQL = `regexp_replace(media_name, '^(?:네이버뉴스|네이버|다음뉴스|구글뉴스)\\((.+)\\)$', '\\1')`;

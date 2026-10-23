import * as cheerio from "cheerio";
import { parseRssPublishedAt } from "./crawlRuntime";

export interface ArticlePageMetadata {
  title?: string;
  publishedAt?: string;
  evidence: string[];
}

function cleanText(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

function dateIso(value: unknown): string | undefined {
  const text = cleanText(value);
  if (!text) return undefined;
  const parsed = parseRssPublishedAt({ pubDate: text });
  return parsed?.toISOString();
}

function typesOf(value: unknown): string[] {
  const values = Array.isArray(value) ? value : [value];
  return values.filter((item): item is string => typeof item === "string");
}

/**
 * Extract only declarative metadata. JavaScript is never executed. Structured
 * NewsArticle/Article data outranks generic OpenGraph and document-title data.
 */
export function inspectArticleMetadata(html: string): ArticlePageMetadata {
  const $ = cheerio.load(html);
  const evidence: string[] = [];
  const objects: Record<string, unknown>[] = [];

  const visit = (value: unknown, depth = 0): void => {
    if (!value || typeof value !== "object" || depth > 12 || objects.length > 3000) return;
    if (Array.isArray(value)) {
      for (const child of value) visit(child, depth + 1);
      return;
    }
    const object = value as Record<string, unknown>;
    objects.push(object);
    for (const child of Object.values(object)) visit(child, depth + 1);
  };

  $("script[type='application/ld+json']").each((_index, element) => {
    try { visit(JSON.parse($(element).text())); }
    catch { /* Malformed optional metadata is ignored. */ }
  });

  let title: string | undefined;
  let publishedAt: string | undefined;

  const articleObjects = objects.filter((object) =>
    typesOf(object["@type"]).some((type) => /(?:NewsArticle|Article|ReportageNewsArticle)$/i.test(type)),
  );
  for (const object of articleObjects) {
    if (!title) {
      title = cleanText(object.headline) || cleanText(object.name) || undefined;
      if (title) evidence.push("schema.org:headline");
    }
    if (!publishedAt) {
      publishedAt = dateIso(object.datePublished) || dateIso(object.dateCreated) || dateIso(object.uploadDate);
      if (publishedAt) evidence.push("schema.org:datePublished");
    }
    if (title && publishedAt) break;
  }

  const meta = (selectors: string[]): string => {
    for (const selector of selectors) {
      const value = cleanText($(selector).first().attr("content"));
      if (value) return value;
    }
    return "";
  };

  if (!title) {
    title = meta([
      "meta[property='og:title']",
      "meta[name='twitter:title']",
      "meta[name='title']",
    ]) || cleanText($("title").first().text()) || undefined;
    if (title) evidence.push("meta:title");
  }

  if (!publishedAt) {
    const raw = meta([
      "meta[property='article:published_time']",
      "meta[name='article:published_time']",
      "meta[name='datePublished']",
      "meta[itemprop='datePublished']",
      "meta[name='pubdate']",
      "meta[name='publishdate']",
      "meta[name='parsely-pub-date']",
      "meta[name='dcterms.date']",
      "meta[name='dc.date']",
    ]);
    publishedAt = dateIso(raw);
    if (publishedAt) evidence.push("meta:published-time");
  }

  if (title && title.length > 500) title = title.slice(0, 500).trim();
  return { title, publishedAt, evidence };
}

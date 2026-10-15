import * as cheerio from "cheerio";

export interface ArticleText { text: string; complete: boolean }
// Never use the whole document: menus and related-story headlines can mention
// the island on an otherwise unrelated article.
export function extractArticleText(html: string): ArticleText {
  const $ = cheerio.load(html);
  const bodies: string[] = [];
  const visit = (value: unknown, depth = 0): void => {
    if (!value || typeof value !== "object" || depth > 10) return;
    if (Array.isArray(value)) { value.forEach(v => visit(v, depth + 1)); return; }
    const obj = value as Record<string, unknown>;
    if (String(obj["@type"]).includes("Article") && typeof obj.articleBody === "string") bodies.push(obj.articleBody);
    Object.values(obj).forEach(v => visit(v, depth + 1));
  };
  $("script[type='application/ld+json']").each((_i, el) => { try { visit(JSON.parse($(el).text())); } catch {} });
  $("script,style,noscript,nav,footer,aside,header,[class*='related'],[class*='recommend'],[class*='copyright'],.ad,.ads").remove();
  const selectors = ["[itemprop='articleBody']", "#dic_area", "#articeBody", "#articleBody", "#article-view-content-div", "#newsct_article", "#newsEndContents", ".article_view", ".article-body", ".story_area", "article"];
  for (const selector of selectors) {
    const nodes = $(selector);
    if (!nodes.length) continue;
    nodes.each((_i, el) => { const copy = $(el).clone(); copy.find("br,p").before("\n"); bodies.push(copy.text()); });
    break;
  }
  const clean = (s: string) => s.replace(/[ \t]+/g, " ").replace(/\n\s*\n/g, "\n").trim();
  const body = bodies.map(clean).sort((a,b) => b.length - a.length)[0] || "";
  const description = $("meta[property='og:description']").attr("content") || $("meta[name='description']").attr("content") || "";
  const title = $("meta[property='og:title']").attr("content") || "";
  return {text: clean([title, description, body].filter(Boolean).join("\n")).slice(0, 60_000), complete: body.length >= 200 && body.length < 55_000};
}

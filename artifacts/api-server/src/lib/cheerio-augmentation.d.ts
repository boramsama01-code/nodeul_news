import "cheerio";

declare module "cheerio" {
  // Cheerio's public ESM entry does not re-export domhandler.AnyNode.
  // This alias is used only for a local helper's generic parameter.
  type AnyNode = any;
}

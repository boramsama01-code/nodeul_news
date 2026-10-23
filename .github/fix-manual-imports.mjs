import { readFile, writeFile } from "node:fs/promises";

const path = "artifacts/web/src/pages/articles.tsx";
let text = await readFile(path, "utf8");
const from = '{/^https?:///i.test(article.url) ? (';
const to = '{(article.url.startsWith("http://") || article.url.startsWith("https://")) ? (';
if (!text.includes(from)) throw new Error("generated URL condition anchor was not found");
text = text.replace(from, to);
await writeFile(path, text);

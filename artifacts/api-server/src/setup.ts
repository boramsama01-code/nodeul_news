import { readFile } from "node:fs/promises";
import { pool } from "@workspace/db";

try {
  if (process.argv.includes("--create-database")) {
    const exists = await pool.query("SELECT 1 FROM pg_database WHERE datname = 'nodeul_news'");
    if (!exists.rowCount) await pool.query("CREATE DATABASE nodeul_news");
  } else if (process.argv.includes("--schema")) {
    const exists = await pool.query("SELECT to_regclass('public.articles') AS name");
    if (!exists.rows[0].name) await pool.query(await readFile("deploy/init.sql", "utf8"));
  } else if (process.argv.includes("--import")) {
    const file = process.argv[process.argv.indexOf("--import") + 1];
    if (!file) throw new Error("SQL 백업 파일 경로가 필요합니다.");
    const sql = await readFile(file, "utf8");
    const match = sql.match(/COPY public\.articles \(([^)]+)\) FROM stdin;\r?\n([\s\S]*?)\r?\n\\\./);
    if (!match) throw new Error("articles COPY 데이터가 있는 PostgreSQL 백업만 지원합니다.");
    const allowed = new Set(["title", "content", "url", "published_at", "media_name", "is_negative", "is_self_pr", "source", "created_at", "deleted_at"]);
    const columns = match[1].split(",").map(x => x.trim());
    const indexes = columns.map((c, i) => ({c, i})).filter(({c}) => allowed.has(c));
    if (!["title", "url", "published_at", "media_name"].every(c => columns.includes(c))) throw new Error("필수 기사 열이 없습니다.");
    const decode = (value: string): string | null => value === "\\N" ? null : value.replace(/\\([btnrfv\\])/g, (_, c: string) => ({b:"\b",t:"\t",n:"\n",r:"\r",f:"\f",v:"\v","\\":"\\"}[c]!));
    const rows = match[2] ? match[2].split(/\r?\n/).map(line => line.split("\t")) : [];
    const client = await pool.connect();
    let inserted = 0;
    try {
      await client.query("BEGIN");
      for (let offset = 0; offset < rows.length; offset += 100) {
        const values: (string | null)[] = [];
        const groups = rows.slice(offset, offset + 100).map(row => {
          if (row.length !== columns.length) throw new Error("백업 행의 열 개수가 다릅니다.");
          return `(${indexes.map(({i}) => {values.push(decode(row[i])); return `$${values.length}`;}).join(",")})`;
        });
        const result = await client.query(`INSERT INTO articles (${indexes.map(({c}) => c).join(",")}) VALUES ${groups.join(",")} ON CONFLICT (url,source) DO NOTHING`, values);
        inserted += result.rowCount || 0;
      }
      await client.query("COMMIT");
      console.log(`Imported ${inserted} articles; existing matching articles were preserved.`);
    } catch (err) { await client.query("ROLLBACK"); throw err; }
    finally { client.release(); }
  } else if (process.argv.includes("--backup")) {
    const { writeFile } = await import("node:fs/promises");
    const file = process.argv[process.argv.indexOf("--backup") + 1];
    if (!file) throw new Error("백업 파일 경로가 필요합니다.");
    const result = await pool.query("SELECT * FROM articles ORDER BY id");
    const columns = ["title", "content", "url", "published_at", "media_name", "is_negative", "is_self_pr", "source", "created_at", "deleted_at"];
    const encode = (value: unknown): string => value == null ? "\\N" : (value instanceof Date ? value.toISOString() : String(value)).replace(/\\/g, "\\\\").replace(/\t/g, "\\t").replace(/\n/g, "\\n").replace(/\r/g, "\\r");
    const output = `COPY public.articles (${columns.join(", ")}) FROM stdin;\n` + result.rows.map(row => columns.map(c => encode(row[c])).join("\t")).join("\n") + "\n\\.\n";
    await writeFile(file, output, { flag: "wx" });
    console.log(`Backed up ${result.rowCount} articles.`);
  }
} finally { await pool.end(); }

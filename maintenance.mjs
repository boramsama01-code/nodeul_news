import { readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const root = dirname(fileURLToPath(import.meta.url));
const [command, ...args] = process.argv.slice(2);
if (!["auditSources", "repairPublishers", "historyAudit", "diagnose", "setup"].includes(command)) throw new Error("Unsupported maintenance command");
if (existsSync(join(root, ".env"))) process.loadEnvFile(join(root, ".env"));
const data = join(root, ".local");
const secret = join(data, "database-password");
const env = { ...process.env, NODE_ENV: "production", DATA_DIR: data };
if (existsSync(secret)) env.DATABASE_URL = `postgresql://nodeul:${readFileSync(secret, "utf8").trim()}@127.0.0.1:${process.env.LOCAL_DB_PORT || 55432}/nodeul_news`;
const configPath = join(data, "runtime-config.json");
if (existsSync(configPath)) {
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  if (config.naverClientId && config.naverClientSecret) {
    env.NAVER_CLIENT_ID = config.naverClientId;
    env.NAVER_CLIENT_SECRET = config.naverClientSecret;
  }
}
const result = spawnSync(process.execPath, [join(root, "dist", `${command}.mjs`), ...args], {cwd:root,env,stdio:"inherit",windowsHide:true});
process.exitCode = result.status ?? 1;

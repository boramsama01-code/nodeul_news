import { spawnSync } from "node:child_process";

// Never expose a Render deployment while its authentication is unconfigured.
for (const name of ["DATABASE_URL", "APP_PASSWORD", "CONFIG_ENCRYPTION_KEY"]) {
  if (!process.env[name]) throw new Error(`${name} must be configured before starting Render.`);
}
if (process.env.APP_PASSWORD.length < 16) throw new Error("APP_PASSWORD must contain at least 16 characters.");
if (process.env.CONFIG_ENCRYPTION_KEY.length < 32) throw new Error("CONFIG_ENCRYPTION_KEY must contain at least 32 characters.");
process.env.STATE_BACKEND = "postgres";
process.env.WEB_DIST ||= "artifacts/web/dist/public";
const setup = spawnSync(process.execPath, ["artifacts/api-server/dist/setup.mjs", "--schema"], { stdio: "inherit" });
if (setup.status !== 0) process.exit(setup.status || 1);
if (process.env.IMPORT_ARCHIVE_ONCE === "true") {
  const imported = spawnSync(process.execPath, ["artifacts/api-server/dist/setup.mjs", "--import", "nodeulnews_data.sql", "--once"], {stdio: "inherit"});
  if (imported.status !== 0) process.exit(imported.status || 1);
}
await import("../artifacts/api-server/dist/index.mjs");

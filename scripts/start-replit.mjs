import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(root);
process.env.PORT ||= "8080";
process.env.NODE_ENV ||= "production";
process.env.RUN_SCHEDULER ??= "true";
process.env.WEB_DIST ||= path.join(root, "artifacts/web/dist/public");
process.env.DATA_DIR ||= path.join(root, ".local");
await import("../artifacts/api-server/dist/index.mjs");

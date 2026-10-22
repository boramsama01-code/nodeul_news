import app from "./app";
import { logger } from "./lib/logger";
import { loadRuntimeConfig } from "./lib/configStore";
import { startScheduler } from "./lib/scheduler";
import { pool } from "@workspace/db";

await loadRuntimeConfig();
const port = Number(process.env.PORT || 8080);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid PORT");
let stopScheduler: (() => void) | undefined;
const server = app.listen(port, process.env.HOST || "0.0.0.0", () => {
  logger.info({ port }, "Server listening");
  if (process.env.RUN_SCHEDULER === "true") stopScheduler = startScheduler();
});
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    stopScheduler?.();
    server.close(() => { void pool.end().finally(() => process.exit(0)); });
    setTimeout(() => process.exit(0), 25000).unref();
  });
}

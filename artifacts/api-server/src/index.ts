import app from "./app";
import { logger } from "./lib/logger";
import { loadRuntimeConfig } from "./lib/configStore";
import { startScheduler } from "./lib/scheduler";

loadRuntimeConfig();
const port = Number(process.env.PORT || 8080);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid PORT");
app.listen(port, process.env.HOST || "0.0.0.0", () => {
  logger.info({ port }, "Server listening");
  if (process.env.RUN_SCHEDULER === "true") startScheduler();
});

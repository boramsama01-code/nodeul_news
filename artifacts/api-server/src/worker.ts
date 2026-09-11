import { pool } from "@workspace/db";
import { loadRuntimeConfig } from "./lib/configStore";
import { collectOnce, startScheduler } from "./lib/scheduler";

loadRuntimeConfig();
if (process.argv.includes("--once")) {
  const index = process.argv.indexOf("--once");
  const [start, end] = process.argv.slice(index + 1);
  if ((start && !end) || (!start && end)) throw new Error("Use --once [YYYY-MM-DD YYYY-MM-DD]");
  try { process.exitCode = await collectOnce(start, end) ? 0 : 1; }
  finally { await pool.end(); }
} else {
  startScheduler();
}

import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";
import path from "node:path";
import { pool } from "@workspace/db";
import { limitWrites } from "./lib/requestLimits";

const app: Express = express();
app.disable("x-powered-by");
app.set("trust proxy", 1); // Render terminates TLS in one proxy hop; req.ip = client

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
// Render must be able to check readiness without access to application data.
app.get("/api/healthz", async (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  try {
    const healthQuery = { text: "SELECT 1", query_timeout: 1000 };
    await pool.query(healthQuery);
    res.json({ status: "ok" });
  } catch { res.status(503).json({ status: "unavailable" }); }
});
app.use((req, res, next) => {
  res.setHeader("X-Robots-Tag", "noindex, nofollow");
  res.setHeader("Cache-Control", "no-store");
  const origin = req.headers.origin;
  if (origin) {
    let sameOrigin = false;
    try { sameOrigin = new URL(origin).host === req.headers.host; } catch {}
    if (!sameOrigin && origin !== process.env.ALLOWED_ORIGIN) {
      res.status(403).json({ error: "허용되지 않은 웹사이트의 요청입니다." }); return;
    }
  }
  next();
});
app.use(cors({ origin: process.env.ALLOWED_ORIGIN || false }));
app.use(express.json({ limit: "64kb" }));
app.use(express.urlencoded({ extended: true }));

// Limit write bursts while keeping collection, editing, export and settings password-free.
app.use("/api", limitWrites());

app.use("/api", router);
app.use("/api", (_req, res) => { res.status(404).json({ error: "API not found" }); });
if (process.env.WEB_DIST) {
  const directory = path.resolve(process.env.WEB_DIST);
  app.use(express.static(directory));
  app.get("/{*path}", (_req, res) => { res.sendFile(path.join(directory, "index.html")); });
}

app.use((_err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  logger.error("Request failed; no request secrets were logged.");
  res.status(500).json({ error: "처리하지 못했습니다. 잠시 후 다시 시도해 주세요." });
});

export default app;

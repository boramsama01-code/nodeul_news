import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";
import path from "node:path";
import { timingSafeEqual } from "node:crypto";

const app: Express = express();

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
app.use((req, res, next) => {
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
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use((req, res, next) => {
  const password = process.env.APP_PASSWORD;
  if (!password) { next(); return; }
  const header = req.headers.authorization || "";
  const decoded = header.startsWith("Basic ") ? Buffer.from(header.slice(6), "base64").toString() : "";
  const expected = Buffer.from(`admin:${password}`);
  const actual = Buffer.from(decoded);
  if (actual.length === expected.length && timingSafeEqual(actual, expected)) { next(); return; }
  res.setHeader("WWW-Authenticate", 'Basic realm="Nodeul News", charset="UTF-8"');
  res.status(401).send("로그인이 필요합니다.");
});

app.use("/api", router);
app.use("/api", (_req, res) => { res.status(404).json({ error: "API not found" }); });
if (process.env.WEB_DIST) {
  const directory = path.resolve(process.env.WEB_DIST);
  app.use(express.static(directory));
  app.get("/{*path}", (_req, res) => { res.sendFile(path.join(directory, "index.html")); });
}

export default app;

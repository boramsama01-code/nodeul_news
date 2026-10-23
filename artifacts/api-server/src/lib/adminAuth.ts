import { createHmac, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";

// Reads stay public (owner's choice). Changing data, starting network
// collection, writing settings and exporting the whole table need the
// administrator. Browsers use a short-lived HttpOnly session cookie obtained
// from POST /api/admin/session; scripts may send Bearer ADMIN_TOKEN or
// Basic admin:APP_PASSWORD. No credential configured = writes refused.
const COOKIE = "nn_admin";
const SESSION_MS = 8 * 3600_000;
const PROTECTED_READS = [/^\/api\/articles\/export(?:\/|$)/];
const OPEN_WRITES = [/^\/api\/admin\/session$/];

function same(a: string, b: string): boolean {
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function adminPassword(): string | undefined {
  const password = process.env.APP_PASSWORD;
  return password && password.length >= 12 ? password : undefined;
}

// Rotating APP_PASSWORD or CONFIG_ENCRYPTION_KEY invalidates every session.
function sessionKey(): string | undefined {
  const password = adminPassword(), secret = process.env.CONFIG_ENCRYPTION_KEY;
  return password && secret ? `${secret}\u0000${password}` : undefined;
}

function sign(expires: number, key: string): string {
  return createHmac("sha256", key).update(`admin:${expires}`).digest("base64url");
}

export function checkPassword(candidate: unknown): boolean {
  const password = adminPassword();
  return !!password && typeof candidate === "string" && same(candidate, password);
}

export function sessionCookie(now = Date.now()): string | undefined {
  const key = sessionKey();
  if (!key) return undefined;
  const expires = now + SESSION_MS;
  return `${expires}.${sign(expires, key)}`;
}

function readCookie(req: Request, name: string): string | undefined {
  for (const part of (req.headers.cookie || "").split(";")) {
    const index = part.indexOf("=");
    if (index > 0 && part.slice(0, index).trim() === name) return decodeURIComponent(part.slice(index + 1).trim());
  }
  return undefined;
}

export function hasValidSession(req: Request, now = Date.now()): boolean {
  const key = sessionKey(), value = readCookie(req, COOKIE);
  if (!key || !value) return false;
  const [expires, signature] = value.split(".");
  return !!expires && !!signature && Number(expires) > now && same(signature, sign(Number(expires), key));
}

export function setSessionCookie(res: Response, value: string): void {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  res.setHeader("Set-Cookie", `${COOKIE}=${encodeURIComponent(value)}; Path=/api; HttpOnly; SameSite=Strict; Max-Age=${SESSION_MS / 1000}${secure}`);
}

export function clearSessionCookie(res: Response): void {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  res.setHeader("Set-Cookie", `${COOKIE}=; Path=/api; HttpOnly; SameSite=Strict; Max-Age=0${secure}`);
}

export function isAdminRequest(req: Request): boolean {
  const header = req.headers.authorization || "";
  const token = process.env.ADMIN_TOKEN;
  if (token && token.length >= 24 && header.startsWith("Bearer ") && same(header.slice(7), token)) return true;
  if (header.startsWith("Basic ")) {
    const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
    const split = decoded.indexOf(":");
    if (split > 0 && same(decoded.slice(0, split), "admin") && checkPassword(decoded.slice(split + 1))) return true;
  }
  return hasValidSession(req);
}

export function needsAdmin(req: Request): boolean {
  const path = req.path;
  if (!path.startsWith("/api/") || path === "/api/healthz" || req.method === "OPTIONS") return false;
  if (req.method === "GET" || req.method === "HEAD") return PROTECTED_READS.some((rule) => rule.test(path));
  return !OPEN_WRITES.some((rule) => rule.test(path));
}

export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (!needsAdmin(req) || isAdminRequest(req)) { next(); return; }
  // No WWW-Authenticate header: the app shows its own login instead of a browser prompt.
  res.status(401).json({ error: "관리자 로그인이 필요합니다.", code: "admin_required" });
}

// Fixed-window limit per client. One Render free instance; a shared store is
// needed if the service is ever scaled out.
export function rateLimit(options: { windowMs: number; max: number; methods?: string[]; now?: () => number; message?: string }) {
  const windows = new Map<string, { start: number; count: number }>();
  const now = options.now ?? Date.now;
  return (req: Request, res: Response, next: NextFunction): void => {
    if (options.methods && !options.methods.includes(req.method)) { next(); return; }
    const key = req.ip || "unknown";
    const at = now();
    const current = windows.get(key);
    if (!current || at - current.start >= options.windowMs) windows.set(key, { start: at, count: 1 });
    else if (++current.count > options.max) {
      res.setHeader("Retry-After", String(Math.ceil((current.start + options.windowMs - at) / 1000)));
      res.status(429).json({ error: options.message ?? "요청이 너무 많습니다." });
      return;
    }
    if (windows.size > 10_000) windows.clear();
    next();
  };
}

// Applied BEFORE requireAdmin so rejected credentials also count.
export const limitWrites = (now?: () => number) =>
  rateLimit({ windowMs: 60_000, max: 30, methods: ["POST", "PUT", "PATCH", "DELETE"], now });
export const limitLogins = (now?: () => number) =>
  rateLimit({ windowMs: 10 * 60_000, max: 5, methods: ["POST"], now, message: "로그인 시도가 너무 많습니다. 10분 뒤 다시 시도해 주세요." });

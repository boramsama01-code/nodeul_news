import type { NextFunction, Request, Response } from "express";

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

export const limitWrites = (now?: () => number) =>
  rateLimit({ windowMs: 60_000, max: 30, methods: ["POST", "PUT", "PATCH", "DELETE"], now });

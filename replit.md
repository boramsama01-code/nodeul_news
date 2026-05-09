# 노들섬 뉴스 모니터

A full-stack Korean news monitoring and benchmarking tool. Crawls 7 news sources, runs AI sentiment analysis via Anthropic, and presents data across 4 pages: Dashboard, Crawl, Articles, Stats.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 8080)
- `pnpm --filter @workspace/web run dev` — run the frontend (port 22333)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL` — Postgres connection string
- Required env: `ANTHROPIC_API_KEY` — for AI sentiment analysis (set this to enable AI features)
- Optional env: `NAVER_CLIENT_ID`, `NAVER_CLIENT_SECRET` — for Naver News API source

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- Frontend: React + Vite + shadcn/ui + React Query + Recharts
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)
- AI: Anthropic Claude via `@anthropic-ai/sdk`
- Crawling: axios + cheerio + rss-parser + iconv-lite

## Where things live

- `artifacts/web/` — React + Vite frontend
- `artifacts/api-server/` — Express 5 API server
- `artifacts/api-server/src/lib/` — crawlers, orchestrator, AI analysis
- `artifacts/api-server/src/routes/` — articles, crawl, stats endpoints
- `lib/db/src/schema/` — Drizzle ORM schema (articles, crawlJobs)
- `lib/api-spec/openapi.yaml` — source-of-truth API contract
- `lib/api-client-react/` — generated React Query hooks (do not edit)
- `lib/api-zod/` — generated Zod schemas (do not edit)

## Architecture decisions

- Contract-first API: OpenAPI spec → Orval codegen → typed hooks + Zod schemas. Never write fetch calls manually.
- Crawl jobs are async: POST /api/crawl starts a background job, frontend polls /api/crawl/:jobId for status.
- Stale running jobs (>10 min) are recovered to "error" on server startup to prevent phantom locks.
- 7 crawl sources: Naver News API, Naver RSS (노들섬), JTBC RSS, SBS RSS, YTN RSS, Google News RSS (노들섬), and Seoul City press releases (web scraping).
- AI analysis is per-article: POST /api/articles/:id/analyze calls Claude to classify isNegative + isSelfPR and writes a summary.

## Product

- **Dashboard**: 4 KPI cards (total articles, statistical, self-PR, negative) + monthly bar chart + recent articles feed.
- **Crawl**: Date range picker → triggers background crawl → real-time progress bar with source tracking.
- **Articles**: Paginated table with year/month/keyword/flag filters, toggle switches for negative/self-PR flags, per-row and bulk AI analysis, manual article entry.
- **Stats**: Year-selector and date-range tabs → grouped bar chart + detailed monthly table with column totals.

## User preferences

_Populate as you build — explicit user instructions worth remembering across sessions._

## Gotchas

- `ANTHROPIC_API_KEY` must be set in Replit Secrets for AI analysis to work. Without it, the analyze endpoint returns 500.
- The Naver News API source requires `NAVER_CLIENT_ID` and `NAVER_CLIENT_SECRET`.
- Run `pnpm --filter @workspace/api-spec run codegen` after any OpenAPI spec change before touching frontend or backend code.
- Never call service ports directly in curl — always use `localhost:80/api/...` through the shared proxy.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details

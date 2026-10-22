-- Additive, repeatable initialization. Never drops or replaces existing data.
CREATE TABLE IF NOT EXISTS articles (
  id serial PRIMARY KEY,
  title text NOT NULL,
  content text NOT NULL DEFAULT '',
  url text NOT NULL,
  published_at timestamptz NOT NULL,
  media_name text NOT NULL,
  is_negative boolean NOT NULL DEFAULT false,
  is_self_pr boolean NOT NULL DEFAULT false,
  source text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT articles_url_source_unique UNIQUE(url, source)
);
CREATE INDEX IF NOT EXISTS articles_published_at_idx ON articles(published_at);
CREATE INDEX IF NOT EXISTS articles_media_name_idx ON articles(media_name);
CREATE INDEX IF NOT EXISTS articles_deleted_at_idx ON articles(deleted_at);
CREATE TABLE IF NOT EXISTS crawl_jobs (
  id text PRIMARY KEY,
  status text NOT NULL DEFAULT 'running',
  collected integer NOT NULL DEFAULT 0,
  duplicates integer NOT NULL DEFAULT 0,
  total integer NOT NULL DEFAULT 0,
  progress integer NOT NULL DEFAULT 0,
  current_source text NOT NULL DEFAULT '',
  error text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS app_state (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

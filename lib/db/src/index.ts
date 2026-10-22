import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 8,
  connectionTimeoutMillis: 3000,
  idleTimeoutMillis: 30000,
});
pool.on("error", () => console.error("Database idle connection failed; the next request will reconnect."));
export const db = drizzle(pool, { schema });

export * from "./schema";

import { pool } from "@workspace/db";

export const usesDatabaseState = () => process.env.STATE_BACKEND === "postgres";

export async function readState<T>(key: string): Promise<T | undefined> {
  const result = await pool.query("SELECT value FROM app_state WHERE key=$1", [key]);
  return result.rows[0]?.value as T | undefined;
}

export async function writeState(key: string, value: unknown): Promise<void> {
  await pool.query(
    "INSERT INTO app_state(key,value) VALUES ($1,$2::jsonb) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=now()",
    [key, JSON.stringify(value)],
  );
}

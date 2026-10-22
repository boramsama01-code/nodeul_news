export const usesDatabaseState = () => process.env.STATE_BACKEND === "postgres";

export async function readState<T>(key: string): Promise<T | undefined> {
  const { pool } = await import("@workspace/db");
  const result = await pool.query("SELECT value FROM app_state WHERE key=$1", [key]);
  return result.rows[0]?.value as T | undefined;
}

export async function writeState(key: string, value: unknown): Promise<void> {
  const { pool } = await import("@workspace/db");
  await pool.query(
    "INSERT INTO app_state(key,value) VALUES ($1,$2::jsonb) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=now()",
    [key, JSON.stringify(value)],
  );
}

export async function readStates<T>(prefix: string): Promise<T[]> {
  const { pool } = await import("@workspace/db");
  const result = await pool.query("SELECT value FROM app_state WHERE starts_with(key,$1) ORDER BY key", [prefix]);
  return result.rows.map(row => row.value as T);
}

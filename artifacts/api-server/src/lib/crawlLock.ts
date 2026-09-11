import { pool } from "@workspace/db";

// All entry points share one PostgreSQL lock, including separate worker processes.
export async function withCrawlLock<T>(run: () => Promise<T>, jobId?: string): Promise<T> {
  const client = await pool.connect();
  let acquired = false;
  try {
    const result = await client.query("SELECT pg_try_advisory_lock(739421) AS acquired");
    acquired = result.rows[0].acquired;
    if (!acquired) throw new Error("다른 수집 작업이 실행 중입니다. 완료 후 다시 시도해 주세요.");
    if (jobId) await client.query("UPDATE crawl_jobs SET status='error', error='이전 실행이 중단되었습니다. 재시작 수집에서 다시 확인합니다.', updated_at=now() WHERE status='running' AND id<>$1", [jobId]);
    return await run();
  } finally {
    try {
      if (acquired) await client.query("SELECT pg_advisory_unlock(739421)");
    } finally {
      client.release();
    }
  }
}

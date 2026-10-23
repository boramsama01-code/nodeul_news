import test from "node:test";
import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";

process.env.DATABASE_URL ||= "postgres://audit:audit@127.0.0.1:1/audit";

test("configured BigKinds payload decodes across chunks", async () => {
  const { decodeBigKindsPayload } = await import("./bigKindsBackfill");
  const rows = [{ i: "BK-1", d: "20260102", m: "연합뉴스", t: "노들섬 공연", c: "노들섬", u: "" }];
  const encoded = gzipSync(Buffer.from(JSON.stringify(rows))).toString("base64");
  const env: NodeJS.ProcessEnv = {
    BIGKINDS_IMPORT_CHUNKS: "2",
    BIGKINDS_IMPORT_00: encoded.slice(0, 10),
    BIGKINDS_IMPORT_01: encoded.slice(10),
  };
  assert.deepEqual(decodeBigKindsPayload(env), rows);
});

test("title matching ignores punctuation but rejects a different story", async () => {
  const { titlesEquivalent } = await import("./bigKindsBackfill");
  assert.equal(
    titlesEquivalent("가을밤 노들섬서 한강 바라보며 음악을", "가을밤, 노들섬서 한강 바라보며 음악을"),
    true,
  );
  assert.equal(
    titlesEquivalent("노들섬 서울뮤직페스티벌 개최", "노들섬 하늘예술정원 공사 입찰"),
    false,
  );
});

test("BigKinds compact dates are interpreted as Korean calendar dates", async () => {
  const { parseBigKindsDate } = await import("./bigKindsBackfill");
  assert.equal(parseBigKindsDate("20260102")?.toISOString(), "2026-01-02T03:00:00.000Z");
  assert.equal(parseBigKindsDate("2026-01-02"), null);
});

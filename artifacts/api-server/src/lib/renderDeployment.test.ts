import test from "node:test";
import assert from "node:assert/strict";
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { encryptConfig, decryptConfig } from "./configEncryption";

process.env.DATABASE_URL ||= "postgresql://localhost/test";
process.env.CONFIG_ENCRYPTION_KEY = "fixture-encryption-key-not-for-production";

test("saved credentials use authenticated encryption and reject tampering or a different key", () => {
  const value = {naverClientSecret:"fixture-private-value"};
  const encrypted = encryptConfig(value);
  assert.ok(!JSON.stringify(encrypted).includes(value.naverClientSecret));
  assert.deepEqual(decryptConfig(encrypted), value);
  const changed = Buffer.from(encrypted.data, "base64");
  changed[0] ^= 1;
  assert.throws(() => decryptConfig({...encrypted, data:changed.toString("base64")}));
  const original = process.env.CONFIG_ENCRYPTION_KEY;
  process.env.CONFIG_ENCRYPTION_KEY = "a-different-fixture-key-not-for-production";
  assert.throws(() => decryptConfig(encrypted));
  process.env.CONFIG_ENCRYPTION_KEY = original;
});

test("cloud credentials survive reload without using local files; failed writes do not activate keys", async () => {
  const {pool} = await import("@workspace/db");
  const {setNaverKeys, loadRuntimeConfig} = await import("./configStore");
  const originalQuery = pool.query;
  const previousBackend = process.env.STATE_BACKEND;
  const directory = await mkdtemp(path.join(tmpdir(), "nodeul-state-"));
  const previousDir = process.env.DATA_DIR;
  const saved = new Map<string, unknown>();
  process.env.DATA_DIR = directory;
  process.env.STATE_BACKEND = "postgres";
  pool.query = (async (sql: string, params: unknown[]) => {
    if (sql.startsWith("INSERT INTO app_state")) saved.set(String(params[0]), JSON.parse(String(params[1])));
    return { rows: saved.has(String(params[0])) ? [{value:saved.get(String(params[0]))}] : [] };
  }) as typeof pool.query;
  try {
    await setNaverKeys("fixture-id", "fixture-secret");
    assert.ok(!JSON.stringify(saved.get("runtime-config")).includes("fixture-secret"));
    delete process.env.NAVER_CLIENT_ID;
    delete process.env.NAVER_CLIENT_SECRET;
    await loadRuntimeConfig();
    assert.equal(process.env.NAVER_CLIENT_SECRET, "fixture-secret");
    assert.deepEqual(await readdir(directory), []);
    pool.query = (async () => {throw new Error("unavailable");}) as typeof pool.query;
    await assert.rejects(setNaverKeys("new-id", "new-secret"));
    assert.equal(process.env.NAVER_CLIENT_SECRET, "fixture-secret");
  } finally {
    pool.query = originalQuery;
    if (previousBackend === undefined) delete process.env.STATE_BACKEND; else process.env.STATE_BACKEND = previousBackend;
    if (previousDir === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = previousDir;
    delete process.env.NAVER_CLIENT_ID;
    delete process.env.NAVER_CLIENT_SECRET;
    await rm(directory, {recursive:true, force:true});
  }
});

test("password-free routes retain origin checks, hide secrets and report database failure", async () => {
  const {pool} = await import("@workspace/db");
  const originalQuery = pool.query;
  pool.query = (async () => ({rows:[{"?column?":1}], rowCount:1, command:"SELECT", oid:0, fields:[]})) as unknown as typeof pool.query;
  const {default:app} = await import("../app");
  // Exercise Express's full request pipeline without opening OS sockets.
  const url = "http://localhost";
  const request = (target: string, options: {headers?: Record<string,string>; method?: string} = {}) => new Promise<{status:number;json:()=>Promise<unknown>;text:()=>Promise<string>}>((resolve, reject) => {
    const req = new IncomingMessage(new Socket());
    req.method = options.method || "GET";
    req.url = new URL(target).pathname;
    req.headers = {host:"localhost", ...Object.fromEntries(Object.entries(options.headers || {}).map(([key,value]) => [key.toLowerCase(),value]))};
    const res = new ServerResponse(req);
    res.end = ((chunk?: string | Buffer) => {
      const body = chunk?.toString() || "";
      resolve({status:res.statusCode, json:async () => JSON.parse(body), text:async () => body});
      return res;
    }) as typeof res.end;
    app(req, res);
    req.on("error", reject);
  });
  try {
    const health = await request(`${url}/api/healthz`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), {status:"ok"});
    assert.equal((await request(`${url}/api/healthz/private`)).status, 404);
    process.env.RENDER_GIT_COMMIT = "0123456789abcdef0123456789abcdef01234567";
    const anonymous = await request(`${url}/api/settings`);
    assert.equal(anonymous.status, 200);
    const anonymousText = await anonymous.text();
    assert.ok(anonymousText.includes("0123456789abcdef"), "the deployed revision is visible without a login");
    assert.equal((await request(`${url}/api/admin/session`)).status, 404, "obsolete login endpoint is absent");
    assert.equal((await request(`${url}/api/crawl/start`, {method:"DELETE"})).status, 404, "unsupported methods reach normal routing without a login");
    assert.equal((await request(`${url}/api/crawl/start`, {method:"OPTIONS"})).status !== 401, true, "preflight is not refused by authentication");
    assert.equal((await request(`${url}/api/settings`, {headers:{Origin:"https://untrusted.example"}})).status, 403);
    pool.query = (async () => {throw new Error("database-secret-must-not-leak");}) as typeof pool.query;
    const failure = await request(`${url}/api/healthz`);
    assert.equal(failure.status, 503);
    assert.deepEqual(await failure.json(), {status:"unavailable"});
  } finally {
    pool.query = originalQuery;
    delete process.env.RENDER_GIT_COMMIT;
  }
});

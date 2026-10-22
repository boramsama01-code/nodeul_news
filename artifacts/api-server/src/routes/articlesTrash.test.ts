import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { PgDialect } from "drizzle-orm/pg-core";
import { and, isNull, not } from "drizzle-orm";

process.env.DATABASE_URL ??= "postgres://localhost/test";

test("bulk irrelevant trash requires explicit mode, previews without writing, then atomically soft-deletes only active nonmatches", async () => {
  const { db, articlesTable } = await import("@workspace/db");
  const { relevantArticleCondition } = await import("../lib/articleRelevance");
  const { default: router } = await import("./articles");
  const originalSelect = db.select;
  const originalUpdate = db.update;
  const expected = new PgDialect().sqlToQuery(and(isNull(articlesTable.deletedAt), not(relevantArticleCondition()))!);
  let reads = 0;
  let writes = 0;
  const verifyCondition = (condition: Parameters<PgDialect["sqlToQuery"]>[0]) => {
    assert.deepEqual(new PgDialect().sqlToQuery(condition), expected);
  };
  db.select = (() => ({ from: () => ({ where: async (condition: Parameters<PgDialect["sqlToQuery"]>[0]) => {
    reads++;
    verifyCondition(condition);
    return [{ count: "2" }];
  } }) })) as unknown as typeof db.select;
  db.update = ((table: unknown) => {
    assert.equal(table, articlesTable);
    return { set: (value: Record<string, unknown>) => {
      assert.deepEqual(Object.keys(value), ["deletedAt"]);
      assert.ok(value.deletedAt instanceof Date);
      return { where: (condition: Parameters<PgDialect["sqlToQuery"]>[0]) => {
        verifyCondition(condition);
        return { returning: async () => { writes++; return writes === 1 ? [{ id: 1 }, { id: 2 }] : []; } };
      } };
    } };
  }) as unknown as typeof db.update;
  const app = express();
  app.use(router);
  const request = (body: unknown) => new Promise<{ status: number; body: unknown }>((resolve, reject) => {
    const req = new IncomingMessage(new Socket());
    req.method = "POST";
    req.url = "/articles/trash-irrelevant";
    Object.assign(req, { body });
    const res = new ServerResponse(req);
    res.end = ((chunk?: string | Buffer) => {
      resolve({ status: res.statusCode, body: JSON.parse(chunk?.toString() || "null") });
      return res;
    }) as typeof res.end;
    req.on("error", reject);
    app(req, res);
  });
  try {
    assert.equal((await request({ dryRun: "false" })).status, 400);
    assert.equal((await request({})).status, 400);
    assert.equal(reads + writes, 0);
    assert.deepEqual(await request({ dryRun: true }), { status: 200, body: { dryRun: true, count: 2 } });
    assert.equal(reads, 1);
    assert.equal(writes, 0);
    assert.deepEqual(await request({ dryRun: false }), { status: 200, body: { dryRun: false, count: 2 } });
    assert.deepEqual(await request({ dryRun: false }), { status: 200, body: { dryRun: false, count: 0 } });
    assert.equal(reads, 1, "mutation evaluates current rows instead of using the preview count");
    assert.equal(writes, 2);
  } finally {
    db.select = originalSelect;
    db.update = originalUpdate;
  }
});

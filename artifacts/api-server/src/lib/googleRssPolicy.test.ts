import test from "node:test";
import assert from "node:assert/strict";
import { GoogleRssCircuitOpenError, requestGoogleRss, withGoogleRssPolicy } from "./googleRssPolicy";

function fakeClock() {
  let timestamp = 0;
  const waits: number[] = [], warnings: string[] = [];
  return { waits, warnings, now: () => timestamp,
    sleep: async (milliseconds: number) => { waits.push(milliseconds); timestamp += milliseconds; },
    warn: (message: string) => { warnings.push(message); },
  };
}

test("concurrent Google requests serialize and start at least 1500ms apart", async () => {
  const clock = fakeClock();
  const starts: number[] = [];
  let active = 0, peak = 0;
  await withGoogleRssPolicy(async () => {
    const results = await Promise.all([1, 2, 3].map(value => requestGoogleRss("2026-01-01", "2026-01-31", async () => {
      active++; peak = Math.max(peak, active); starts.push(clock.now());
      await Promise.resolve(); active--; return value;
    })));
    assert.deepEqual(results, [1, 2, 3]);
  }, clock);
  assert.equal(peak, 1);
  assert.deepEqual(starts, [0, 1500, 3000]);
  assert.deepEqual(clock.waits, [1500, 1500]);
});

test("final 503 opens the job circuit and queued searches skip without requests or waits", async () => {
  const clock = fakeClock();
  let calls = 0;
  await withGoogleRssPolicy(async () => {
    const results = await Promise.allSettled([
      requestGoogleRss("2026-05-01", "2026-05-31", async () => { calls++; throw new Error("Status code 503"); }),
      requestGoogleRss("2026-05-01", "2026-05-31", async () => { calls++; return []; }),
      requestGoogleRss("2026-06-01", "2026-06-30", async () => { calls++; return []; }),
    ]);
    for (const result of results) {
      assert.equal(result.status, "rejected");
      if (result.status === "rejected") assert.ok(result.reason instanceof GoogleRssCircuitOpenError);
    }
  }, clock);
  assert.equal(calls, 1);
  assert.deepEqual(clock.waits, []);
  assert.equal(clock.warnings.length, 2);
  assert.match(clock.warnings[0], /2026-05-01~2026-05-31.*미완료/);
  assert.match(clock.warnings[1], /2026-06-01~2026-06-30.*미완료/);
});

test("429 is recognized but an unrelated feed error does not stop the job", async () => {
  const clock = fakeClock();
  await withGoogleRssPolicy(async () => {
    await assert.rejects(requestGoogleRss("2026-01-01", "2026-01-31", async () => { throw new Error("Invalid XML"); }), /Invalid XML/);
    assert.equal(await requestGoogleRss("2026-01-01", "2026-01-31", async () => "ok"), "ok");
    await assert.rejects(requestGoogleRss("2026-01-01", "2026-01-31", async () => { throw { response: { status: 429 } }; }), GoogleRssCircuitOpenError);
    await assert.rejects(requestGoogleRss("2026-02-01", "2026-02-28", async () => assert.fail("circuit must stop network work")), GoogleRssCircuitOpenError);
  }, clock);
  assert.equal(clock.warnings.length, 2);
});

test("overlapping and later jobs have independent circuits; unwrapped calls are unpaced", async () => {
  const failedClock = fakeClock(), healthyClock = fakeClock();
  const results = await Promise.allSettled([
    withGoogleRssPolicy(() => requestGoogleRss("2026-01-01", "2026-01-31", async () => { throw {statusCode: 503}; }), failedClock),
    withGoogleRssPolicy(() => requestGoogleRss("2026-01-01", "2026-01-31", async () => "other job"), healthyClock),
  ]);
  assert.equal(results[0].status, "rejected");
  assert.deepEqual(results[1], {status:"fulfilled", value:"other job"});
  assert.equal(await withGoogleRssPolicy(() => requestGoogleRss("2026-01-01", "2026-01-31", async () => "new job"), fakeClock()), "new job");
  assert.equal(await requestGoogleRss("2026-01-01", "2026-01-31", async () => "outside job"), "outside job");
});

test("a bounded retry that eventually succeeds does not open the circuit", async () => {
  const clock = fakeClock();
  await withGoogleRssPolicy(async () => {
    const result = await requestGoogleRss("2026-01-01", "2026-01-31", async () => {
      try { throw new Error("Status code 503"); } catch { return "retry succeeded"; }
    });
    assert.equal(result, "retry succeeded");
    assert.equal(await requestGoogleRss("2026-02-01", "2026-02-28", async () => "next month"), "next month");
  }, clock);
  assert.deepEqual(clock.warnings, []);
});

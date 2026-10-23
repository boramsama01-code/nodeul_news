import test from "node:test";
import assert from "node:assert/strict";
import axios from "axios";

test("C-05 shutdown aborts outbound requests, waits for tracked jobs and reports unfinished ones", async () => {
  const { trackBackgroundTask, drainBackgroundTasks, pause, shutdownSignal } = await import("./lifecycle");
  let finalStateWritten = false;
  // A job that ends quickly once requests fail, then writes its final state.
  const job = trackBackgroundTask((async () => {
    await new Promise<void>((resolve) => shutdownSignal.addEventListener("abort", () => resolve(), { once: true }));
    finalStateWritten = true;
  })(), "job-a");
  // A job that ignores the signal and outlives the drain timeout.
  trackBackgroundTask(new Promise(() => {}), "job-b");
  const started = Date.now();
  const unfinished = await drainBackgroundTasks(200);
  await job;
  assert.equal(finalStateWritten, true);
  assert.deepEqual(unfinished, ["job-b"]);
  assert.ok(Date.now() - started < 2_000);
  assert.equal(axios.defaults.signal, shutdownSignal);
  const t0 = Date.now(); await pause(10_000); assert.ok(Date.now() - t0 < 100, "pauses end immediately after shutdown");
});

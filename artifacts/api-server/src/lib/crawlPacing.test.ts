import test from "node:test";
import assert from "node:assert/strict";
import { splitDateRangeByDays } from "./crawlPacing";

test("splitDateRangeByDays covers the range without overlap", () => {
  assert.deepEqual(splitDateRangeByDays("2026-01-01", "2026-01-14", 7), [
    { start: "2026-01-01", end: "2026-01-07" },
    { start: "2026-01-08", end: "2026-01-14" },
  ]);
});

test("splitDateRangeByDays keeps a short tail", () => {
  assert.deepEqual(splitDateRangeByDays("2026-02-25", "2026-03-03", 5), [
    { start: "2026-02-25", end: "2026-03-01" },
    { start: "2026-03-02", end: "2026-03-03" },
  ]);
});

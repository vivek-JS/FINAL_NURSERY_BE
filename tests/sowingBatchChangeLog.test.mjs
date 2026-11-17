import test from "node:test";
import assert from "node:assert/strict";
import { listBatchChangeLog, pushBatchChangeLog } from "../utility/sowingBatchChangeLog.js";

test("change log records cover and excess before/after", () => {
  const batch = {};
  pushBatchChangeLog(batch, {
    kind: "DISPATCH_RELEASE",
    plants: 1000,
    coverBefore: 1000,
    coverAfter: 0,
    excessBefore: 0,
    excessAfter: 1000,
    reason: "Leftover became excess",
  });
  const rows = listBatchChangeLog(batch);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, "DISPATCH_RELEASE");
  assert.equal(rows[0].plants, 1000);
  assert.equal(rows[0].excessAfter, 1000);
});

test("listBatchChangeLog keeps dispatchLog RETURN after changeLog exists", () => {
  const batch = {
    changeLog: [
      {
        at: new Date("2026-10-01T10:00:00.000Z"),
        kind: "DISPATCH_TAKE",
        plants: -500,
        reason: "took leftover",
      },
    ],
    dispatchLog: [
      {
        at: new Date("2026-10-02T10:00:00.000Z"),
        bucket: "RETURN",
        plants: -200,
        reason: "returned",
      },
    ],
  };
  const rows = listBatchChangeLog(batch);
  assert.ok(rows.some((r) => r.kind === "DISPATCH_TAKE"));
  const ret = rows.find((r) => r.kind === "RETURN");
  assert.ok(ret);
  assert.equal(ret.plants, 200);
  assert.equal(ret.reason, "returned");
});

test("listBatchChangeLog defaults RETURN / UNLOAD reasons", () => {
  const batch = {
    changeLog: [],
    dispatchLog: [
      { at: new Date("2026-10-02T10:00:00.000Z"), bucket: "RETURN", plants: -100 },
      { at: new Date("2026-10-03T10:00:00.000Z"), bucket: "UNLOAD", plants: -50 },
    ],
  };
  const rows = listBatchChangeLog(batch);
  const ret = rows.find((r) => r.kind === "RETURN");
  const unload = rows.find((r) => r.kind === "UNLOAD");
  assert.equal(ret.plants, 100);
  assert.equal(ret.reason, "Return from order");
  assert.equal(unload.reason, "Vehicle unload");
});

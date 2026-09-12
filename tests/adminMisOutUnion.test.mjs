import { describe, it } from "node:test";
import assert from "node:assert";
import {
  unionDispatchedWithCompletedByDay,
  unionDispatchedWithCompletedByEntity,
} from "../utility/adminMisMetrics.js";

describe("MIS Out union — Dispatched ∪ Completed, no redundant order", () => {
  it("keeps Out and adds Completed-only on the Done day", () => {
    const dispatched = new Map([
      ["2026-08-10\0a", { day: "2026-08-10", orderId: "a", plants: 1000 }],
    ]);
    const completed = new Map([
      ["2026-08-10\0a", { day: "2026-08-10", orderId: "a", plants: 1000 }],
      ["2026-08-20\0b", { day: "2026-08-20", orderId: "b", plants: 500 }],
    ]);
    const merged = unionDispatchedWithCompletedByDay(dispatched, completed);
    assert.strictEqual(merged.size, 2);
    assert.strictEqual(merged.get("2026-08-10\0a").plants, 1000);
    assert.strictEqual(merged.get("2026-08-20\0b").plants, 500);
  });

  it("does not add Done again when Out was on an earlier day", () => {
    const dispatched = new Map([
      ["2026-08-10\0a", { day: "2026-08-10", orderId: "a", plants: 2000 }],
    ]);
    const completed = new Map([
      ["2026-08-25\0a", { day: "2026-08-25", orderId: "a", plants: 2000 }],
    ]);
    const merged = unionDispatchedWithCompletedByDay(dispatched, completed);
    assert.strictEqual(merged.size, 1);
    assert.strictEqual(merged.get("2026-08-10\0a").day, "2026-08-10");
  });

  it("unions entity rows by order id", () => {
    const dispatched = new Map([
      [
        JSON.stringify({ plantId: "p", subtypeId: "s", orderId: "a" }),
        { _id: { plantId: "p", subtypeId: "s", orderId: "a" }, plants: 1000 },
      ],
    ]);
    const completed = new Map([
      [
        JSON.stringify({ plantId: "p", subtypeId: "s", orderId: "a" }),
        { _id: { plantId: "p", subtypeId: "s", orderId: "a" }, plants: 1000 },
      ],
      [
        JSON.stringify({ plantId: "p", subtypeId: "s", orderId: "c" }),
        { _id: { plantId: "p", subtypeId: "s", orderId: "c" }, plants: 300 },
      ],
    ]);
    const merged = unionDispatchedWithCompletedByEntity(dispatched, completed);
    assert.strictEqual(merged.size, 2);
    const plants = [...merged.values()].reduce((sum, row) => sum + row.plants, 0);
    assert.strictEqual(plants, 1300);
  });
});

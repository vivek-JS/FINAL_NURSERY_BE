import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  mortalityCoverCap,
  planShortSownCover,
  readyDateKey,
} from "../services/shortSownCover.plan.js";

const sowing = (id, ready, extra = {}) => ({
  id,
  ready,
  unassigned: 0,
  excess: 0,
  buffer: 0,
  plantsSowed: 0,
  ...extra,
});

describe("short sown cover plan", () => {
  it("sorts ready dates", () => {
    assert.equal(readyDateKey("17-11-2026"), "2026-11-17");
    assert.equal(readyDateKey("2026-11-17"), "2026-11-17");
  });

  it("caps mortality at 2% of plants sowed", () => {
    assert.equal(mortalityCoverCap(12240), 244);
    assert.equal(mortalityCoverCap(36036), 720);
  });

  it("covers a small gap from the order's own excess and mortality", () => {
    const takes = planShortSownCover({
      gap: 256,
      own: sowing("own", "13-10-2026", { excess: 200, buffer: 1836, plantsSowed: 20000 }),
      sowings: [],
    });
    assert.deepEqual(takes, [
      { id: "own", fromStamp: 0, fromExcess: 200, fromMortality: 56, plants: 256 },
    ]);
  });

  it("does not pass 2% mortality on the own sowing", () => {
    const takes = planShortSownCover({
      gap: 256,
      own: sowing("own", "13-10-2026", { excess: 0, buffer: 1836, plantsSowed: 12240 }),
      sowings: [],
    });
    assert.equal(takes, null);
  });

  it("continues onto the next sowing when the own sowing cannot finish", () => {
    const takes = planShortSownCover({
      gap: 1000,
      own: sowing("own", "17-11-2026", { excess: 100, buffer: 50, plantsSowed: 1000 }),
      sowings: [
        sowing("next", "20-11-2026", { excess: 900, buffer: 400, plantsSowed: 5000 }),
        sowing("later", "25-11-2026", { excess: 5000, buffer: 400, plantsSowed: 5000 }),
      ],
    });
    assert.deepEqual(takes, [
      { id: "own", fromStamp: 0, fromExcess: 100, fromMortality: 20, plants: 120 },
      { id: "next", fromStamp: 0, fromExcess: 880, fromMortality: 0, plants: 880 },
    ]);
  });

  it("uses an earlier sowing only for plants already covered and not on an order", () => {
    const takes = planShortSownCover({
      gap: 5000,
      own: sowing("own", "17-11-2026", { unassigned: 1000, excess: 500, buffer: 1000, plantsSowed: 10000 }),
      sowings: [
        sowing("next", "20-11-2026", { excess: 200, buffer: 1000, plantsSowed: 10000 }),
        sowing("earlier", "13-11-2026", { unassigned: 4000, excess: 9000, buffer: 9000, plantsSowed: 100000 }),
      ],
    });
    assert.deepEqual(takes, [
      { id: "own", fromStamp: 1000, fromExcess: 500, fromMortality: 200, plants: 1700 },
      { id: "next", fromStamp: 0, fromExcess: 200, fromMortality: 200, plants: 400 },
      { id: "earlier", fromStamp: 2900, fromExcess: 0, fromMortality: 0, plants: 2900 },
    ]);
  });

  it("leaves the order alone when the variety still cannot finish it", () => {
    const takes = planShortSownCover({
      gap: 78000,
      own: sowing("own", "17-11-2026", { excess: 100, plantsSowed: 1000, buffer: 1000 }),
      sowings: [sowing("next", "20-11-2026", { excess: 50, plantsSowed: 1000, buffer: 1000 })],
    });
    assert.equal(takes, null);
  });
});

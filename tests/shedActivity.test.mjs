import { describe, it } from "node:test";
import assert from "node:assert";
import { SHED_ACTIVITY_ACTIONS } from "../services/shedActivity.service.js";
import { computePendingSlotSync } from "../services/secondaryShedSlotStock.service.js";

describe("shedActivity — action constants", () => {
  it("includes lagwad, slot link, bypass, and sync actions", () => {
    assert.ok(SHED_ACTIVITY_ACTIONS.SECONDARY_LAGWAD_RECORDED);
    assert.ok(SHED_ACTIVITY_ACTIONS.SECONDARY_SLOT_LINKED);
    assert.ok(SHED_ACTIVITY_ACTIONS.SECONDARY_READINESS_BYPASS);
    assert.ok(SHED_ACTIVITY_ACTIONS.SECONDARY_SLOT_RELOCATE);
    assert.ok(SHED_ACTIVITY_ACTIONS.SECONDARY_SLOT_SYNC);
  });
});

describe("slot sync policy — sow then calendar ready", () => {
  it("full inward qty is pending until slotStockSyncedPlants catches up", () => {
    assert.strictEqual(computePendingSlotSync(500, 0), 500);
    assert.strictEqual(computePendingSlotSync(500, 500), 0);
  });

  it("after partial sync, only remainder is pending", () => {
    assert.strictEqual(computePendingSlotSync(500, 200), 300);
  });
});

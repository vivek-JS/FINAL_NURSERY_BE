import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  replayFarmerPlantLedgerEntry,
  replayRamAgriLedgerEntry,
  replayDealerLedgerEntry,
  createOrderCache,
} from "../../modules/finance/integration/replaySubLedgerToCentral.js";

describe("replaySubLedgerToCentral", () => {
  it("returns skipped_empty for null entry", async () => {
    const ctx = createOrderCache();
    assert.equal((await replayFarmerPlantLedgerEntry(null, ctx)).status, "skipped_empty");
    assert.equal((await replayRamAgriLedgerEntry(null, ctx)).status, "skipped_empty");
    assert.equal((await replayDealerLedgerEntry(null, ctx)).status, "skipped_empty");
  });
});

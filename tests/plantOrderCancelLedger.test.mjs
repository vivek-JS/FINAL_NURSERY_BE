import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  isTerminalPlantOrderStatus,
  getPlantOrderLineTotal,
} from "../utils/farmerPlantOrderLedgerHelper.js";

describe("plant order cancel ledger helpers", () => {
  it("isTerminalPlantOrderStatus includes CANCELLED, REJECTED, TEMPORARY_CANCELLED", () => {
    assert.equal(isTerminalPlantOrderStatus("CANCELLED"), true);
    assert.equal(isTerminalPlantOrderStatus("REJECTED"), true);
    assert.equal(isTerminalPlantOrderStatus("TEMPORARY_CANCELLED"), true);
    assert.equal(isTerminalPlantOrderStatus("ACCEPTED"), false);
    assert.equal(isTerminalPlantOrderStatus("cancelled"), true);
  });

  it("getPlantOrderLineTotal uses rate × plants", () => {
    const total = getPlantOrderLineTotal({
      rate: 12.5,
      numberOfPlants: 100,
      additionalPlants: 20,
    });
    assert.equal(total, 1500);
  });
});

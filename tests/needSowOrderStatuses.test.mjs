import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  NEED_SOW_ORDER_STATUSES,
  NEED_SOW_ORDER_STATUS_SET,
} from "../constants/sowingGapOrderStatuses.js";

describe("need sow statuses", () => {
  it("only ACCEPTED counts toward need sow", () => {
    assert.deepEqual(NEED_SOW_ORDER_STATUSES, ["ACCEPTED"]);
    assert.equal(NEED_SOW_ORDER_STATUS_SET.has("ACCEPTED"), true);
    assert.equal(NEED_SOW_ORDER_STATUS_SET.has("PENDING"), false);
    assert.equal(NEED_SOW_ORDER_STATUS_SET.has("DISPATCHED"), false);
    assert.equal(NEED_SOW_ORDER_STATUS_SET.has("COMPLETED"), false);
    assert.equal(NEED_SOW_ORDER_STATUS_SET.has("READY_FOR_DISPATCH"), false);
    assert.equal(NEED_SOW_ORDER_STATUS_SET.has("DISPATCH_PROCESS"), false);
    assert.equal(NEED_SOW_ORDER_STATUS_SET.has("FARM_READY"), false);
  });
});

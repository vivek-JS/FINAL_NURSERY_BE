import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  NEED_SOW_ORDER_STATUSES,
  NEED_SOW_ORDER_STATUS_SET,
  UNSOWN_SOW_BOARD_STATUSES,
  UNSOWN_SOW_BOARD_STATUS_SET,
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

  it("not-sown board includes pre-dispatch pipeline statuses", () => {
    assert.equal(UNSOWN_SOW_BOARD_STATUS_SET.has("ACCEPTED"), true);
    assert.equal(UNSOWN_SOW_BOARD_STATUS_SET.has("DISPATCH_PROCESS"), true);
    assert.equal(UNSOWN_SOW_BOARD_STATUS_SET.has("READY_FOR_DISPATCH"), true);
    assert.equal(UNSOWN_SOW_BOARD_STATUS_SET.has("DISPATCHED"), false);
    assert.equal(UNSOWN_SOW_BOARD_STATUS_SET.has("PENDING"), false);
    assert.ok(UNSOWN_SOW_BOARD_STATUSES.length > NEED_SOW_ORDER_STATUSES.length);
  });
});

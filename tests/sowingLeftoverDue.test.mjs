import { describe, it } from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import {
  incompleteLeftoverFilter,
  leftoverBookingSlotIdSet,
  leftoverLiveOrderFilter,
  leftoverOrderIdSet,
  orderWiseIncludeClause,
} from "../services/sowingLeftoverDue.service.js";

describe("sowingLeftoverDue helpers export", () => {
  it("exports slot and order set loaders", () => {
    assert.equal(typeof leftoverBookingSlotIdSet, "function");
    assert.equal(typeof leftoverOrderIdSet, "function");
  });
});

describe("incomplete leftovers ignore booking slot", () => {
  it("matches leftoverFromIncomplete orders even when uncovered ids are empty", () => {
    const filter = leftoverLiveOrderFilter(
      { plantId: "691054dffba6fb380f8d57b3", subtypeId: "6947ad805c0108fb438e35fc" },
      []
    );
    assert.deepEqual(filter.$or, [{ leftoverFromIncomplete: true }]);
    assert.equal(filter.sowingDone.$ne, true);
    assert.equal(String(filter.plantName), "691054dffba6fb380f8d57b3");
  });

  it("includes flagged orders whose slot is not in the drawer slot list", () => {
    const slotId = new mongoose.Types.ObjectId();
    const orderId = new mongoose.Types.ObjectId();
    const clause = orderWiseIncludeClause([slotId], [{ _id: orderId }], ["ACCEPTED"]);
    assert.deepEqual(clause.$or[0].orderStatus, { $in: ["ACCEPTED"] });
    assert.deepEqual(clause.$or[1], { _id: { $in: [orderId] } });
    assert.equal(clause.$or[1].orderStatus, undefined);
  });

  it("keeps only accepted leftovers", () => {
    const filter = incompleteLeftoverFilter({
      plantId: "p1",
      subtypeId: "s1",
    });
    assert.equal(filter.leftoverFromIncomplete, true);
    assert.deepEqual(filter.orderStatus.$in, ["ACCEPTED"]);
  });
});

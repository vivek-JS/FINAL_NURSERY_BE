import test from "node:test";
import assert from "node:assert/strict";
import { computeCompleteDispatchPlantsToDeduct } from "../services/completeDispatchShedDeduction.service.js";

const oid = "6773f61461f4388d1bb59b7b";

test("computeCompleteDispatchPlantsToDeduct uses dispatchQuantity minus returns/damaged", () => {
  const dispatch = {
    orderDispatchDetails: [{ orderId: oid, dispatchQuantity: 5000 }],
  };
  const order = { _id: oid, numberOfPlants: 5000, remainingPlants: 0 };
  const qty = computeCompleteDispatchPlantsToDeduct({
    dispatch,
    order,
    returnsForThisOrder: 200,
    damagedForThisOrder: 50,
  });
  assert.equal(qty, 4750);
});

test("manual batch source skips lagwad deduction (handled in service)", async () => {
  const { applyCompleteDispatchShedDeduction } = await import(
    "../services/completeDispatchShedDeduction.service.js"
  );
  const result = await applyCompleteDispatchShedDeduction({
    session: {},
    order: { _id: oid, deliveryCompleteBatch: {} },
    dispatch: { _id: "507f1f77bcf86cd799439012" },
    batchSnapshot: { batchNumber: "CUSTOM-LOT", source: "manual" },
  });
  assert.equal(result.skipped, true);
  assert.equal(result.reason, "manual");
});

test("computeCompleteDispatchPlantsToDeduct falls back when dispatchQuantity missing", () => {
  const dispatch = { orderDispatchDetails: [{ orderId: oid }] };
  const order = {
    _id: oid,
    numberOfPlants: 3000,
    additionalPlants: 0,
    remainingPlants: 500,
  };
  const qty = computeCompleteDispatchPlantsToDeduct({
    dispatch,
    order,
    returnsForThisOrder: 0,
    damagedForThisOrder: 0,
  });
  assert.equal(qty, 2500);
});

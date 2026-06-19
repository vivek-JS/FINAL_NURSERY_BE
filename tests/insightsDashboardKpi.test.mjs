import test from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import {
  buildExpectedKpiMatchStage,
  computeDispatchKpiSummary,
  mapExpectedKpiOrder,
} from "../controllers/insights.controller.js";

test("expected KPI match is delivery-date scoped, not booking-date scoped", () => {
  const plantId = "507f1f77bcf86cd799439011";
  const subtypeObjectId = new mongoose.Types.ObjectId("507f1f77bcf86cd799439012");
  const salesUserId = new mongoose.Types.ObjectId("507f1f77bcf86cd799439013");

  const match = buildExpectedKpiMatchStage({
    reportDateStr: "2026-06-19",
    plantId,
    subtypeObjectId,
    excludeReadyForDispatch: true,
    user: { jobTitle: "SALES", _id: salesUserId },
  });

  assert.equal(Object.hasOwn(match, "orderBookingDate"), false);
  assert.equal(match.deliveryDate.$lt.toISOString(), "2026-06-26T18:30:00.000Z");
  assert.equal(String(match.plantName), plantId);
  assert.equal(String(match.plantSubtype), String(subtypeObjectId));
  assert.equal(String(match.salesPerson), String(salesUserId));
  assert.ok(match.orderStatus.$nin.includes("COMPLETED"));
  assert.ok(match.orderStatus.$nin.includes("READY_FOR_DISPATCH"));
});

test("expected KPI order fallback includes additional plants", () => {
  const subtypeId = new mongoose.Types.ObjectId("507f1f77bcf86cd799439014");
  const mapped = mapExpectedKpiOrder({
    orderId: "A-1",
    orderStatus: "ACCEPTED",
    numberOfPlants: 100,
    additionalPlants: 25,
    deliveryDate: new Date("2026-06-19T05:00:00.000Z"),
    farmer: { name: "Farmer", districtName: "Pune" },
    salesPerson: { name: "Sales" },
    plantName: { _id: "507f1f77bcf86cd799439011", subtypes: [{ _id: subtypeId, name: "G9" }] },
    plantSubtype: subtypeId,
  });

  assert.equal(mapped.qty, 125);
  assert.equal(mapped.remainingPlants, 125);

  const summary = computeDispatchKpiSummary([mapped], [], "2026-06-19");
  assert.equal(summary.todayExpected.plantCount, 125);
  assert.equal(summary.todayExpected.orderCount, 1);
});

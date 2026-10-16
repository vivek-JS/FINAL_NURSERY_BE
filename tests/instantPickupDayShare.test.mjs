import test from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import {
  buildInstantPickupDispatch,
  instantOrderPlantLines,
  isInstantOrderRequest,
  INSTANT_PICKUP_DRIVER,
} from "../services/instantPickupDispatch.service.js";
import {
  buildDispatchDayLines,
  istDayRange,
  netOutwardPlants,
} from "../services/dispatchDaySummary.service.js";

const id = () => new mongoose.Types.ObjectId();

test("isInstantOrderRequest: instant flag without a vehicle only", () => {
  assert.equal(isInstantOrderRequest({ instantDispatch: true }), true);
  assert.equal(isInstantOrderRequest({ instantDispatch: "true" }), true);
  assert.equal(isInstantOrderRequest({ instantDispatch: true, dispatchId: "abc" }), false);
  assert.equal(isInstantOrderRequest({}), false);
});

test("instantOrderPlantLines: root order counts additional plants", () => {
  const order = { plantName: id(), plantSubtype: id(), numberOfPlants: 500, additionalPlants: 20, cavity: id() };
  const lines = instantOrderPlantLines(order);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].plants, 520);
  assert.equal(lines[0].cavity, String(order.cavity));
});

test("instantOrderPlantLines: multi-plant order uses plantLineItems and falls back to order tray", () => {
  const cavity = id();
  const order = {
    cavity,
    plantLineItems: [
      { plantName: id(), plantSubtype: id(), numberOfPlants: 300, plantNameSnapshot: "Banana", plantSubtypeSnapshot: "G9" },
      { plantName: id(), plantSubtype: id(), numberOfPlants: 0 },
    ],
  };
  const lines = instantOrderPlantLines(order);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].plantName, "Banana");
  assert.equal(lines[0].cavity, String(cavity));
});

test("buildInstantPickupDispatch: one row per plant with crate target from the tray", () => {
  const tray = { _id: id(), name: "126 Cavity", cavity: 126, numberPerCrate: 126 };
  const order = { _id: id(), orderId: 4321 };
  const lines = [
    { plantId: String(id()), subTypeId: String(id()), plants: 300, cavity: String(tray._id), plantName: "Papaya", subtypeName: "Taiwan" },
  ];
  const doc = buildInstantPickupDispatch(order, {
    lines,
    trayById: new Map([[String(tray._id), tray]]),
    fallbackTray: tray,
  });
  assert.equal(doc.transportId, "INSTANT-4321");
  assert.equal(doc.isInstantPickup, true);
  assert.equal(doc.transportStatus, "PENDING");
  assert.equal(doc.driverName, INSTANT_PICKUP_DRIVER);
  assert.equal(doc.plantsDetails[0].name, "Papaya -> Taiwan");
  assert.equal(doc.plantsDetails[0].crates[0].crateCount, 3);
  assert.equal(doc.orderDispatchDetails[0].dispatchQuantity, 300);
  assert.equal(doc.orderDispatchDetails[0].remainingAfterDispatch, 0);
});

test("istDayRange: IST midnight to midnight", () => {
  const r = istDayRange("2026-10-16");
  assert.equal(r.start.toISOString(), "2026-10-15T18:30:00.000Z");
  assert.equal(r.end.toISOString(), "2026-10-16T18:30:00.000Z");
  assert.equal(istDayRange("16/10/2026"), null);
});

test("netOutwardPlants: returns come off their source line, else same batch lines", () => {
  const d = String(id());
  const b = String(id());
  const outwards = [
    { soId: "a", dispatchId: d, batchId: b, plants: 100 },
    { soId: "b", dispatchId: d, batchId: b, plants: 50 },
  ];
  const left = netOutwardPlants(outwards, new Map([[d, [
    { sourceOutwardId: "b", quantity: 20 },
    { batchId: b, quantity: 110 },
  ]]]));
  assert.equal(left.get("a"), 0);
  assert.equal(left.get("b"), 20);
});

test("buildDispatchDayLines: vehicle and pickup lines with order, batch and shed", () => {
  const vehicle = { _id: id(), transportId: "1123", vehicleName: "Tata", vehicleNumber: "MH12", driverName: "Raju", plantsDetails: [], shedReturns: [] };
  const pickup = { _id: id(), transportId: "INSTANT-9", isInstantPickup: true, driverName: INSTANT_PICKUP_DRIVER, plantsDetails: [], shedReturns: [] };
  const order = { _id: id(), orderId: 9, farmer: { name: "Ramesh", village: "Wai" } };
  const batch = { _id: id(), batchNumber: "B-77", plantCmsId: id(), plantSubtypeId: id() };
  const outwards = [
    { soId: "1", dispatchId: vehicle._id, batchId: batch._id, plants: 200, shed: "Shed 12", at: new Date(2) },
    { soId: "2", dispatchId: pickup._id, orderId: order._id, batchId: batch._id, plants: 50, shed: "Shed 14", at: new Date(1) },
  ];
  const lines = buildDispatchDayLines({
    outwards,
    dispatchById: new Map([vehicle, pickup].map((d) => [String(d._id), d])),
    orderById: new Map([[String(order._id), order]]),
    batchById: new Map([[String(batch._id), batch]]),
    plantNameOf: () => ({ plant: "Banana", subtype: "G9" }),
  });
  assert.equal(lines.length, 2);
  assert.equal(lines[0].isInstantPickup, true);
  assert.equal(lines[0].farmer, "Ramesh");
  assert.equal(lines[0].orderCode, "9");
  assert.equal(lines[0].vehicle, "");
  assert.equal(lines[1].vehicle, "Tata · MH12");
  assert.equal(lines[1].batch, "B-77");
  assert.equal(lines[1].shed, "Shed 12");
  assert.equal(lines[1].crop, "Banana");
});

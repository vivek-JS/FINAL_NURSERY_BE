import test from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import {
  buildMisOrdersMatch,
} from "../services/adminMisOrders.service.js";
import { istDayBoundsFromYmd } from "../utility/istOrderDateStats.js";

const window = {
  rangeStart: istDayBoundsFromYmd("2026-05-26").start,
  rangeEnd: istDayBoundsFromYmd("2026-05-26").end,
  startYmd: "2026-05-26",
  endYmd: "2026-05-26",
};

test("buildMisOrdersMatch accepted uses delivery + ACCEPTED", () => {
  const m = buildMisOrdersMatch({ bucket: "accepted", mode: "delivery" }, window);
  assert.equal(m.orderStatus, "ACCEPTED");
  assert.ok(m.deliveryDate);
});

test("buildMisOrdersMatch farmReady is global status only", () => {
  const m = buildMisOrdersMatch({ bucket: "farmReady", mode: "delivery" }, window);
  assert.equal(m.orderStatus, "FARM_READY");
  assert.equal(m.deliveryDate, undefined);
});

test("buildMisOrdersMatch dispatched uses transition kind", () => {
  const m = buildMisOrdersMatch({ bucket: "dispatched", mode: "delivery" }, window);
  assert.equal(m.kind, "transition");
  assert.equal(m.newStatus, "DISPATCHED");
});

test("buildMisOrdersMatch coerces plantId and subtypeId to ObjectId for aggregation", () => {
  const plantHex = "68fdf6d45832d541b274acfa";
  const subtypeHex = "6944c7e75845df7093731ba2";
  const m = buildMisOrdersMatch(
    {
      bucket: "dispatched",
      mode: "delivery",
      plantId: plantHex,
      subtypeId: subtypeHex,
    },
    window
  );
  assert.equal(m.kind, "transition");
  assert.ok(m.extra.plantName instanceof mongoose.Types.ObjectId);
  assert.ok(m.extra.plantSubtype instanceof mongoose.Types.ObjectId);
  assert.equal(String(m.extra.plantName), plantHex);
});

test("buildMisOrdersMatch completed uses transition kind", () => {
  const m = buildMisOrdersMatch({ bucket: "completed", mode: "delivery" }, window);
  assert.equal(m.kind, "transition");
  assert.equal(m.newStatus, "COMPLETED");
});

test("buildMisOrdersMatch dueOnly does not block dispatched", () => {
  const m = buildMisOrdersMatch(
    { bucket: "dispatched", mode: "delivery", dueOnly: "true" },
    window
  );
  assert.equal(m.kind, "transition");
  assert.equal(m.newStatus, "DISPATCHED");
});

test("buildMisOrdersMatch deliveryTotal single day is in-range only", () => {
  const m = buildMisOrdersMatch(
    { bucket: "deliveryTotal", mode: "delivery", date: "2026-05-26" },
    window
  );
  assert.ok(m.deliveryDate);
  assert.equal(m.$or, undefined);
  assert.ok(m.orderStatus?.$nin?.includes("DISPATCHED"));
});

test("buildMisOrdersMatch deliveryTotal variety scope is in-range only", () => {
  const rangeWindow = {
    rangeStart: istDayBoundsFromYmd("2026-05-01").start,
    rangeEnd: istDayBoundsFromYmd("2026-05-07").end,
  };
  const m = buildMisOrdersMatch(
    {
      bucket: "deliveryTotal",
      mode: "delivery",
      scope: "variety",
      plantId: "507f1f77bcf86cd799439011",
      subtypeId: "507f1f77bcf86cd799439012",
    },
    rangeWindow
  );
  assert.ok(m.deliveryDate);
  assert.equal(m.$or, undefined);
  assert.ok(m.orderStatus?.$nin?.includes("DISPATCHED"));
});

test("buildMisOrdersMatch deliveryTotal range uses union", () => {
  const rangeWindow = {
    rangeStart: istDayBoundsFromYmd("2026-05-01").start,
    rangeEnd: istDayBoundsFromYmd("2026-05-07").end,
  };
  const m = buildMisOrdersMatch(
    { bucket: "deliveryTotal", mode: "delivery" },
    rangeWindow
  );
  assert.ok(Array.isArray(m.$or));
});

test("buildMisOrdersMatch drawerSegment inRange splits from includeAllPastDue union", () => {
  const rangeWindow = {
    rangeStart: istDayBoundsFromYmd("2026-05-01").start,
    rangeEnd: istDayBoundsFromYmd("2026-05-07").end,
  };
  const m = buildMisOrdersMatch(
    {
      bucket: "deliveryTotal",
      mode: "delivery",
      includeAllPastDue: "true",
      drawerSegment: "inRange",
    },
    rangeWindow
  );
  assert.ok(m.deliveryDate);
  assert.equal(m.$or, undefined);
});

test("buildMisOrdersMatch includeAllPastDue uses due backlog not FR union", () => {
  const rangeWindow = {
    rangeStart: istDayBoundsFromYmd("2026-05-01").start,
    rangeEnd: istDayBoundsFromYmd("2026-05-07").end,
  };
  const m = buildMisOrdersMatch(
    {
      bucket: "deliveryTotal",
      mode: "delivery",
      includeAllPastDue: "true",
    },
    rangeWindow
  );
  assert.ok(Array.isArray(m.$or));
  assert.equal(m.$or.length, 2);
  const hasFarmReadyUnion = m.$or.some((b) => b.orderStatus === "FARM_READY");
  assert.equal(hasFarmReadyUnion, false);
});

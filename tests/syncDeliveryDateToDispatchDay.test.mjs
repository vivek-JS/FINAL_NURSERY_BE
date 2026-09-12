import test from "node:test";
import assert from "node:assert/strict";
import {
  isPostDispatchStatus,
  resolveDispatchAt,
  shouldApplyDeliveryDateSync,
  buildDeliveryDateSyncFields,
  shouldMoveSlotForDispatchDay,
} from "../utility/syncDeliveryDateToDispatchDay.js";
import { formatIstYmd } from "../utility/istCalendar.js";

const booked20Sep = new Date("2026-09-19T18:30:00.000Z"); // 20 Sep 2026 IST
const dispatched13Sep = new Date("2026-09-13T08:30:00.000Z"); // 13 Sep 2026 IST
const sameDay20Sep = new Date("2026-09-20T10:15:00.000Z"); // still 20 Sep IST

test("isPostDispatchStatus covers DISPATCHED / COMPLETED / PARTIALLY_COMPLETED only", () => {
  assert.equal(isPostDispatchStatus("DISPATCHED"), true);
  assert.equal(isPostDispatchStatus("COMPLETED"), true);
  assert.equal(isPostDispatchStatus("PARTIALLY_COMPLETED"), true);
  assert.equal(isPostDispatchStatus("DISPATCH_PROCESS"), false);
  assert.equal(isPostDispatchStatus("READY_FOR_DISPATCH"), false);
});

test("same IST day does not sync", () => {
  assert.equal(
    shouldApplyDeliveryDateSync({
      previousStatus: "READY_FOR_DISPATCH",
      nextStatus: "DISPATCHED",
      previousDeliveryDate: booked20Sep,
      dispatchAt: sameDay20Sep,
    }),
    false
  );
});

test("different day + entering DISPATCHED syncs", () => {
  assert.equal(
    shouldApplyDeliveryDateSync({
      previousStatus: "READY_FOR_DISPATCH",
      nextStatus: "DISPATCHED",
      previousDeliveryDate: booked20Sep,
      dispatchAt: dispatched13Sep,
    }),
    true
  );
});

test("DISPATCH_PROCESS does not sync", () => {
  assert.equal(
    shouldApplyDeliveryDateSync({
      previousStatus: "READY_FOR_DISPATCH",
      nextStatus: "DISPATCH_PROCESS",
      previousDeliveryDate: booked20Sep,
      dispatchAt: dispatched13Sep,
    }),
    false
  );
});

test("already DISPATCHED with no status change does not re-sync", () => {
  assert.equal(
    shouldApplyDeliveryDateSync({
      previousStatus: "DISPATCHED",
      nextStatus: "DISPATCHED",
      previousDeliveryDate: booked20Sep,
      dispatchAt: dispatched13Sep,
    }),
    false
  );
});

test("DISPATCHED to COMPLETED still syncs if dates differ", () => {
  assert.equal(
    shouldApplyDeliveryDateSync({
      previousStatus: "DISPATCHED",
      nextStatus: "COMPLETED",
      previousDeliveryDate: booked20Sep,
      dispatchAt: dispatched13Sep,
    }),
    true
  );
});

test("COMPLETED when already synced does not write", () => {
  assert.equal(
    shouldApplyDeliveryDateSync({
      previousStatus: "DISPATCHED",
      nextStatus: "COMPLETED",
      previousDeliveryDate: dispatched13Sep,
      dispatchAt: dispatched13Sep,
    }),
    false
  );
});

test("buildDeliveryDateSyncFields sets deliveryDate and preserves oldDeliveryDate", () => {
  const fields = buildDeliveryDateSyncFields(
    { deliveryDate: booked20Sep },
    dispatched13Sep
  );
  assert.ok(fields);
  assert.equal(formatIstYmd(fields.deliveryDate), "2026-09-13");
  assert.equal(fields.oldDeliveryDate, booked20Sep);
});

test("buildDeliveryDateSyncFields does not overwrite existing oldDeliveryDate", () => {
  const original = new Date("2026-09-01T18:30:00.000Z");
  const fields = buildDeliveryDateSyncFields(
    { deliveryDate: booked20Sep, oldDeliveryDate: original },
    dispatched13Sep
  );
  assert.equal(fields.oldDeliveryDate, undefined);
});

test("missing deliveryDate + DISPATCHED still sets dispatch day", () => {
  const fields = buildDeliveryDateSyncFields({}, dispatched13Sep);
  assert.equal(formatIstYmd(fields.deliveryDate), "2026-09-13");
  assert.equal(fields.oldDeliveryDate, undefined);
});

test("resolveDispatchAt prefers incoming dispatchHistory date", () => {
  const resolved = resolveDispatchAt({
    previousOrder: {
      dispatchHistory: [{ date: booked20Sep }],
    },
    updateOperation: {
      $push: { dispatchHistory: { date: dispatched13Sep } },
    },
  });
  assert.equal(formatIstYmd(resolved), "2026-09-13");
});

test("dispatch day outside current slot window should move", () => {
  const slot = { startDay: "16-09-2026", endDay: "30-09-2026" };
  assert.equal(shouldMoveSlotForDispatchDay(slot, dispatched13Sep), true);
  assert.equal(shouldMoveSlotForDispatchDay(slot, booked20Sep), false);
});

import test from "node:test";
import assert from "node:assert/strict";
import {
  parseOrderStatusList,
  resolveOrderStatusTokens,
  buildOrderStatusDateMatch,
  parseOrderListDateDdMmYyyy,
  NEEDS_DISPATCH_STATUSES,
} from "../utility/orderListQuery.js";

test("parseOrderStatusList splits comma-separated statuses and uppercases", () => {
  assert.deepEqual(parseOrderStatusList("pending, accepted"), [
    "PENDING",
    "ACCEPTED",
    "ASSIGNED",
  ]);
});

test("parseOrderStatusList handles repeated query keys as array", () => {
  assert.deepEqual(parseOrderStatusList(["PENDING", "FARM_READY"]), [
    "PENDING",
    "FARM_READY",
  ]);
});

test("resolveOrderStatusTokens needsDispatch overrides explicit status", () => {
  assert.deepEqual(
    resolveOrderStatusTokens("true", "CANCELLED"),
    NEEDS_DISPATCH_STATUSES
  );
  assert.deepEqual(resolveOrderStatusTokens(false, "PENDING"), ["PENDING"]);
});

test("buildOrderStatusDateMatch applies date field to all statuses", () => {
  const start = new Date("2026-06-01T00:00:00.000Z");
  const end = new Date("2026-06-10T23:59:59.999Z");
  const match = buildOrderStatusDateMatch(
    ["PENDING", "ACCEPTED", "FARM_READY", "READY_FOR_DISPATCH"],
    { field: "deliveryDate", start, end }
  );
  assert.ok(!match.$or);
  assert.deepEqual(match.orderStatus.$in, [
    "PENDING",
    "ACCEPTED",
    "FARM_READY",
    "READY_FOR_DISPATCH",
  ]);
  assert.equal(match.deliveryDate.$gte.getTime(), start.getTime());
  assert.equal(match.deliveryDate.$lte.getTime(), end.getTime());
});

test("parseOrderListDateDdMmYyyy uses IST calendar day bounds", () => {
  const start = parseOrderListDateDdMmYyyy("01-02-2025", false);
  const end = parseOrderListDateDdMmYyyy("01-02-2025", true);
  assert.equal(start.toISOString(), "2025-01-31T18:30:00.000Z");
  assert.equal(end.toISOString(), "2025-02-01T18:29:59.999Z");

  const feb1LocalMidnight = new Date("2025-01-31T18:30:00.000Z");
  assert.ok(feb1LocalMidnight >= start);
  assert.ok(feb1LocalMidnight <= end);

  const jan31EndIst = parseOrderListDateDdMmYyyy("31-01-2025", true);
  assert.ok(feb1LocalMidnight > jan31EndIst);
});

test("buildOrderStatusDateMatch booking vs delivery uses different fields", () => {
  const start = new Date("2026-05-13T00:00:00.000Z");
  const end = new Date("2026-05-26T23:59:59.999Z");
  const delivery = buildOrderStatusDateMatch(["ACCEPTED", "FARM_READY"], {
    field: "deliveryDate",
    start,
    end,
  });
  const booking = buildOrderStatusDateMatch(["ACCEPTED", "FARM_READY"], {
    field: "orderBookingDate",
    start,
    end,
  });
  assert.ok(delivery.deliveryDate);
  assert.ok(booking.orderBookingDate);
  assert.ok(!delivery.orderBookingDate);
  assert.ok(!booking.deliveryDate);
});

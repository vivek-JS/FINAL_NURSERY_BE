import test from "node:test";
import assert from "node:assert/strict";
import { allocateVirtualCover } from "../utility/virtualCover.js";

test("a delivery takes the oldest sowing already ready, then the next sowing", () => {
  const result = allocateVirtualCover(
    [
      { orderNumber: 4002, farmerName: "Prashant", deliveryDate: "2026-11-07", bookingDate: "2026-10-01", plants: 10000 },
      { orderNumber: 3982, farmerName: "Nanadkishore", deliveryDate: "2026-11-07", bookingDate: "2026-09-01", plants: 18000 },
      { orderNumber: 9001, farmerName: "New", deliveryDate: "2026-11-27", bookingDate: "2026-11-08", plants: 3000 },
    ],
    [
      { requestNumber: "SR-A", sowingDate: "2026-10-20", plantReadyDate: "2026-11-07", remaining: 19749 },
      { requestNumber: "SR-B", sowingDate: "2026-10-22", plantReadyDate: "2026-11-09", remaining: 8251 },
      { requestNumber: "SR-C", sowingDate: "2026-11-05", plantReadyDate: "2026-11-23", remaining: 5000 },
    ]
  );
  const first = result.orders[0];
  assert.equal(first.orderNumber, 3982);
  assert.deepEqual(first.covers, [
    { requestNumber: "SR-A", sowingDate: "2026-10-20", plantReadyDate: "2026-11-07", shedName: "", plants: 18000 },
  ]);
  const second = result.orders[1];
  assert.equal(second.covers[0].plants, 1749);
  assert.equal(second.covers[0].requestNumber, "SR-A");
  assert.equal(second.covers[1].plants, 8251);
  assert.equal(second.covers[1].plantReadyDate, "2026-11-09");
  const third = result.orders[2];
  assert.equal(third.covers[0].plantReadyDate, "2026-11-23");
  assert.equal(third.covers[0].plants, 3000);
  assert.equal(third.short, 0);
});

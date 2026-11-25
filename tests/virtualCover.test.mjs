import test from "node:test";
import assert from "node:assert/strict";
import { allocateVirtualCover, applyVirtualOut } from "../utility/virtualCover.js";

test("Fresh is deducted first even when order is covered from another sowing", () => {
  const sowings = [
    { entryId: "e1", batchId: "b1", requestNumber: "SR-17Nov", sowingDate: "2026-10-30", plantReadyDate: "2026-11-17", remaining: 40360 },
    { entryId: "e2", batchId: "b2", requestNumber: "SR-Fresh", sowingDate: "2026-11-01", plantReadyDate: "2026-11-19", sowingName: "Fresh", remaining: 6703 },
    { entryId: "e3", batchId: "b3", requestNumber: "SR-21Nov", sowingDate: "2026-11-03", plantReadyDate: "2026-11-21", remaining: 36369 },
    { entryId: "e4", batchId: "b4", requestNumber: "SR-25Nov", sowingDate: "2026-11-07", plantReadyDate: "2026-11-25", remaining: 45128 },
  ];
  const dispatched = [
    { orderId: "o4691", orderNumber: 4691, deliveryDate: "2026-11-24", plants: 11000, covers: [{ batchId: "b4", requestNumber: "SR-25Nov", plants: 14000 }] },
  ];
  const openOrders = [
    { orderId: "o3664", orderNumber: 3664, deliveryDate: "2026-11-25", plants: 12000, covers: [{ requestNumber: "SR-OLD-1", plants: 12000 }] },
    { orderId: "o4233", orderNumber: 4233, deliveryDate: "2026-11-25", plants: 10000, covers: [{ requestNumber: "SR-OLD-1", plants: 10000 }] },
    { orderId: "o4292", orderNumber: 4292, deliveryDate: "2026-11-25", plants: 7000, covers: [{ requestNumber: "SR-OLD-2", plants: 9000 }] },
    { orderId: "o4928", orderNumber: 4928, deliveryDate: "2026-11-26", plants: 20000, covers: [{ batchId: "b4", requestNumber: "SR-25Nov", plants: 20000 }] },
    { orderId: "o4839", orderNumber: 4839, deliveryDate: "2026-11-28", plants: 8000, covers: [{ batchId: "b1", requestNumber: "SR-17Nov", plants: 8000 }] },
  ];

  // Before dispatch: #4691 is in openOrders (11,000) -> Can Book = 60,560
  const before = allocateVirtualCover([...openOrders, ...dispatched], sowings);
  assert.equal(before.left, 60560);

  // After dispatch: #4691 moves to Virtual Out -> Can Book stays 60,560
  const afterOut = applyVirtualOut(dispatched, sowings);
  assert.equal(afterOut.totalOut, 11000);
  const freshAfterOut = afterOut.sowings.find((s) => s.requestNumber === "SR-Fresh");
  const nov25AfterOut = afterOut.sowings.find((s) => s.requestNumber === "SR-25Nov");
  assert.equal(freshAfterOut.virtualOut, 6703);
  assert.equal(freshAfterOut.virtualRemaining, 0);
  assert.equal(nov25AfterOut.virtualOut, 4297);
  assert.equal(nov25AfterOut.virtualRemaining, 40831);

  const after = allocateVirtualCover(openOrders, afterOut.sowings);
  assert.equal(after.left, 60560);
  const byReq = Object.fromEntries(after.perSowing.map((s) => [s.requestNumber, s]));
  assert.equal(byReq["SR-Fresh"].virtualExcess, 0);
  assert.equal(byReq["SR-17Nov"].virtualExcess, 3360);
  assert.equal(byReq["SR-21Nov"].virtualExcess, 36369);
  assert.equal(byReq["SR-25Nov"].virtualExcess, 20831);
});

test("Nearest sowing is picked when no sowing is ready on or before delivery date", () => {
  const sowings = [
    { requestNumber: "SR-Dec10", sowingDate: "2026-11-20", plantReadyDate: "2026-12-10", remaining: 10000 },
    { requestNumber: "SR-Dec02", sowingDate: "2026-11-12", plantReadyDate: "2026-12-02", remaining: 10000 },
  ];
  const orders = [
    { orderId: "o1", orderNumber: 1, deliveryDate: "2026-11-28", plants: 4000, covers: [] },
  ];
  const res = allocateVirtualCover(orders, sowings);
  assert.equal(res.orders[0].covers[0].requestNumber, "SR-Dec02");
  assert.equal(res.orders[0].covers[0].plants, 4000);
  assert.equal(res.left, 16000);
});

test("Own linked sowing is protected from earlier unlinked FIFO orders", () => {
  const sowings = [
    { batchId: "b1", requestNumber: "SR-1", sowingDate: "2026-11-01", plantReadyDate: "2026-11-20", remaining: 10000 },
    { batchId: "b2", requestNumber: "SR-2", sowingDate: "2026-11-05", plantReadyDate: "2026-11-24", remaining: 10000 },
  ];
  const orders = [
    { orderId: "o1", orderNumber: 1, deliveryDate: "2026-11-20", plants: 10000, covers: [] },
    { orderId: "o2", orderNumber: 2, deliveryDate: "2026-11-25", plants: 10000, covers: [{ batchId: "b1", requestNumber: "SR-1", plants: 10000 }] },
  ];
  const res = allocateVirtualCover(orders, sowings);
  assert.equal(res.orders.find((o) => o.orderId === "o2").covers[0].requestNumber, "SR-1");
  assert.equal(res.orders.find((o) => o.orderId === "o1").covers[0].requestNumber, "SR-2");
});

test("Unlinked orders with delivery >= today + plantReadyDays are excluded as canSow", () => {
  const sowings = [
    { entryId: "e1", batchId: "b1", requestNumber: "SR-17Nov", sowingDate: "2026-10-30", plantReadyDate: "2026-11-17", remaining: 3360 },
    { entryId: "e3", batchId: "b3", requestNumber: "SR-21Nov", sowingDate: "2026-11-03", plantReadyDate: "2026-11-21", remaining: 36369 },
    { entryId: "e4", batchId: "b4", requestNumber: "SR-25Nov", sowingDate: "2026-11-07", plantReadyDate: "2026-11-25", remaining: 20831 },
  ];
  const orders = [
    { orderId: "o4953", orderNumber: 4953, deliveryDate: "2026-12-25", plants: 50000, covers: [] },
  ];
  const res = allocateVirtualCover(orders, sowings, { today: "2026-11-25", plantReadyDays: 18 });
  assert.equal(res.left, 60560);
  assert.equal(res.orders[0].canSow, true);
  assert.equal(res.orders[0].short, 50000);
  assert.equal(res.orders[0].sowBy, "2026-12-07");
  assert.deepEqual(res.orders[0].covers, []);

  // An unlinked order for 28 Nov (< 13 Dec) is NOT sowable and still deducts from stock
  const near = allocateVirtualCover(
    [{ orderId: "o9999", orderNumber: 9999, deliveryDate: "2026-11-28", plants: 50000, covers: [] }],
    sowings,
    { today: "2026-11-25", plantReadyDays: 18 }
  );
  assert.equal(near.left, 10560);
  assert.equal(near.orders[0].canSow, false);
  assert.equal(near.orders[0].short, 0);
});

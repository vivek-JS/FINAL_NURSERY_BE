import test from "node:test";
import assert from "node:assert/strict";
import {
  baseOrderLinks,
  applySowBatchLinks,
  remainingOrderLinks,
  dispatchedByBatchOrder,
  indexSowBatches,
  planSowBatchLoad,
  describeSowPlanLine,
  applySowPlanLineToSlots,
  sowLinkMovesForLine,
} from "../services/sowDispatchBatches.service.js";
import { isVehicleLoadCompleteByRows } from "../services/secondaryVehicleLoad.service.js";

const OID = {
  s15: "650000000000000000000015",
  s16: "650000000000000000000016",
  s17: "650000000000000000000017",
  b15: "650000000000000000000115",
  b16: "650000000000000000000116",
  b17: "650000000000000000000117",
  r15: "650000000000000000000215",
  X: "650000000000000000000a01",
  Y1: "650000000000000000000a02",
  Y2: "650000000000000000000a03",
  Y3: "650000000000000000000a04",
};

const slotDocs = () => [
  {
    subtypeSlots: [
      {
        subtypeId: "st",
        slots: [
          {
            _id: OID.s15,
            orderReservedPlants: 3600,
            availablePlants: 400,
            excessiveSowing: { plants: 400 },
            sowingBatches: [
              {
                _id: OID.b15,
                sowingRequestId: OID.r15,
                sowingDate: "25-09-2026",
                plantReadyDate: "15-10-2026",
                plantsSowed: 4000,
                orderCoveredPlants: 3600,
                excessPlants: 400,
                linkedOrderIds: [OID.X],
                noMortalityReserve: true,
              },
            ],
          },
          {
            _id: OID.s17,
            orderReservedPlants: 3700,
            availablePlants: 300,
            excessiveSowing: { plants: 300 },
            sowingBatches: [
              {
                _id: OID.b17,
                sowingDate: "27-09-2026",
                plantReadyDate: "17-10-2026",
                plantsSowed: 4000,
                orderCoveredPlants: 3700,
                excessPlants: 300,
                linkedOrderIds: [OID.Y1, OID.Y2],
                noMortalityReserve: true,
                dispatchLog: [],
              },
            ],
          },
        ],
      },
    ],
  },
];

test("linked batch: direct sow uses the request's batch, excess cover uses its (moved) source", () => {
  const index = indexSowBatches(slotDocs(), "st");
  assert.deepEqual(
    baseOrderLinks({ _id: OID.X, sowingDoneRequestId: OID.r15, numberOfPlants: 1000 }, index),
    [{ slotId: OID.s15, batchId: OID.b15, plants: 1000 }]
  );
  const cover = {
    _id: OID.Y1,
    sowingDoneRequestId: "audit",
    sowingCoverSources: [
      { slotId: OID.s16, batchId: OID.b16, plants: 500, moved: true, destSlotId: OID.s17, destBatchId: OID.b17 },
      { slotId: OID.s15, batchId: OID.b15, plants: 200 },
    ],
  };
  assert.deepEqual(baseOrderLinks(cover, index), [
    { slotId: OID.s17, batchId: OID.b17, plants: 500 },
    { slotId: OID.s15, batchId: OID.b15, plants: 200 },
  ]);
  assert.deepEqual(baseOrderLinks({ ...cover, sowingCoverReversedAt: new Date() }, index), []);
});

test("sowBatchLinks move plants between batches; an order can end up split across two", () => {
  const links = applySowBatchLinks(
    [{ slotId: OID.s15, batchId: OID.b15, plants: 1000 }],
    [{ fromBatchId: OID.b15, slotId: OID.s17, batchId: OID.b17, plants: 700, at: new Date(1) }]
  );
  assert.deepEqual(links, [
    { slotId: OID.s15, batchId: OID.b15, plants: 300 },
    { slotId: OID.s17, batchId: OID.b17, plants: 700 },
  ]);
});

test("remaining links subtract what already left the batch for that order", () => {
  const docs = slotDocs();
  docs[0].subtypeSlots[0].slots[0].sowingBatches[0].dispatchLog = [
    { orderId: OID.X, plants: 600 },
    { orderId: OID.X, plants: -100 },
  ];
  const index = indexSowBatches(docs, "st");
  const map = dispatchedByBatchOrder(index);
  const rem = remainingOrderLinks(
    { _id: OID.X, sowingDoneRequestId: OID.r15, numberOfPlants: 1000 },
    index,
    map
  );
  assert.equal(rem[0].plants, 500);
});

const example = (free17 = 300) => ({
  orderLinks: new Map([[OID.X, [{ slotId: OID.s15, batchId: OID.b15, plants: 1000 }]]]),
  batches: new Map([
    [OID.b15, { slotId: OID.s15, free: 400, orders: [] }],
    [
      OID.b17,
      {
        slotId: OID.s17,
        free: free17,
        orders: [
          { orderId: OID.Y2, plants: 2000, deliveryMs: 20, bookedMs: 1 },
          { orderId: OID.Y1, plants: 500, deliveryMs: 10, bookedMs: 5 },
          { orderId: OID.Y3, plants: 300, deliveryMs: 10, bookedMs: 2 },
        ],
      },
    ],
  ]),
});

test("own linked batch is COVER", () => {
  const plan = planSowBatchLoad({
    selections: [{ orderId: OID.X, batchId: OID.b15, plants: 1000 }],
    ...example(),
  });
  assert.equal(plan.ok, true);
  assert.equal(plan.lines[0].bucket, "COVER");
  assert.equal(plan.lines[0].cover, 1000);
});

test("15/16/17 Oct: excess used first, rest relinked FIFO by delivery then booking, leftover becomes excess", () => {
  const plan = planSowBatchLoad({
    selections: [{ orderId: OID.X, batchId: OID.b17, plants: 1000 }],
    ...example(300),
  });
  assert.equal(plan.ok, true);
  const line = plan.lines[0];
  assert.equal(line.bucket, "SWITCH");
  assert.equal(line.fromFree, 300);
  assert.deepEqual(
    line.relinks.map((r) => [r.orderId, r.plants, r.toBatchId]),
    [
      [OID.Y3, 300, OID.b15],
      [OID.Y1, 400, OID.b15],
    ]
  );
  assert.equal(line.released.length, 1);
  assert.equal(line.released[0].plants, 1000);
  assert.equal(line.released[0].leftover, 300);
  assert.equal(line.fromFree, line.released[0].leftover);
});

test("orders already on a vehicle are never relinked", () => {
  const ctx = example(0);
  ctx.batches.get(OID.b17).orders = [{ orderId: OID.Y1, plants: 400, deliveryMs: 1 }];
  const plan = planSowBatchLoad({
    selections: [{ orderId: OID.X, batchId: OID.b17, plants: 1000 }],
    ...ctx,
  });
  assert.equal(plan.ok, false);
  assert.match(plan.error, /booked by other orders/);
});

test("orders loaded in the same submit are not used as relink takers", () => {
  const ctx = example(0);
  ctx.orderLinks.set(OID.Y3, [{ slotId: OID.s17, batchId: OID.b17, plants: 300 }]);
  const plan = planSowBatchLoad({
    selections: [
      { orderId: OID.X, batchId: OID.b17, plants: 500 },
      { orderId: OID.Y3, batchId: OID.b17, plants: 300 },
    ],
    ...ctx,
  });
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.lines[0].relinks.map((r) => r.orderId), [OID.Y1]);
  assert.equal(plan.lines[1].bucket, "COVER");
});

test("order with no linked batch takes free excess, then other orders with no relink", () => {
  const ctx = example(300);
  const ok = planSowBatchLoad({ selections: [{ orderId: "new", batchId: OID.b17, plants: 300 }], ...ctx });
  assert.equal(ok.ok, true);
  assert.equal(ok.lines[0].bucket, "FREE");
  assert.equal(ok.lines[0].fromFree, 300);
  assert.equal(ok.lines[0].unlinkedTakes.length, 0);

  const short = planSowBatchLoad({ selections: [{ orderId: "new", batchId: OID.b17, plants: 301 }], ...ctx });
  assert.equal(short.ok, true);
  const line = short.lines[0];
  assert.equal(line.bucket, "FREE");
  assert.equal(line.fromFree, 300);
  assert.equal(line.relinks.length, 0);
  assert.deepEqual(line.unlinkedTakes.map((t) => [t.orderId, t.plants]), [[OID.Y3, 1]]);
  assert.equal(line.warnings.length, 1);

  const moves = sowLinkMovesForLine(line, { dispatchId: OID.s16, now: new Date() });
  const taken = moves.find((m) => m.orderId === OID.Y3);
  assert.equal(taken.entry.reason, "DISPATCH_FREE");
  assert.equal(taken.entry.batchId, undefined);
  assert.equal(String(taken.entry.fromBatchId), OID.b17);
  const after = applySowBatchLinks(
    [{ slotId: OID.s17, batchId: OID.b17, plants: 300 }],
    [taken.entry]
  );
  assert.deepEqual(after, [{ slotId: OID.s17, batchId: OID.b17, plants: 299 }]);
});

test("an order split across two batches: own part is COVER, the rest switches", () => {
  const ctx = example(300);
  ctx.orderLinks.set(OID.X, [
    { slotId: OID.s15, batchId: OID.b15, plants: 600 },
    { slotId: OID.s17, batchId: OID.b17, plants: 400 },
  ]);
  const plan = planSowBatchLoad({ selections: [{ orderId: OID.X, batchId: OID.b17, plants: 1000 }], ...ctx });
  assert.equal(plan.ok, true);
  const line = plan.lines[0];
  assert.equal(line.cover, 400);
  assert.equal(line.fromFree, 300);
  assert.equal(line.relinks.reduce((s, r) => s + r.plants, 0), 300);
  assert.equal(line.released[0].leftover, 300);
});

test("slot and batch counters for a switch, clamped at 0", () => {
  const index = indexSowBatches(slotDocs(), "st");
  const plan = planSowBatchLoad({
    selections: [{ orderId: OID.X, batchId: OID.b17, plants: 1000 }],
    ...example(300),
  });
  const line = plan.lines[0];
  const res = applySowPlanLineToSlots({ line, batchIndex: index, performedBy: null, transportId: "T1", now: new Date() });
  const s15 = index.get(OID.b15).slot;
  const s17 = index.get(OID.b17).slot;
  const b15 = index.get(OID.b15).batch;
  const b17 = index.get(OID.b17).batch;
  assert.equal(b17.orderCoveredPlants, 4000);
  assert.equal(b17.excessPlants, 0);
  assert.equal(b17.excessAllocations[0].plants, 300);
  assert.equal(b15.orderCoveredPlants, 3300);
  assert.equal(b15.excessPlants, 700);
  assert.equal(s15.availablePlants, 700);
  assert.equal(s15.orderReservedPlants, 3300);
  assert.equal(s15.excessiveSowing.plants, 700);
  assert.deepEqual(res, { reservedDec: 1000, availableDec: 0, touchedSlots: res.touchedSlots });
  assert.equal(s17.availablePlants, 0);
  assert.equal(s17.orderReservedPlants, 3000);
  assert.ok(b17.linkedOrderIds.some((x) => String(x) === OID.X));
  assert.ok(b15.linkedOrderIds.some((x) => String(x) === OID.Y1));
});

test("link moves record the dispatched order and the relinked orders", () => {
  const plan = planSowBatchLoad({
    selections: [{ orderId: OID.X, batchId: OID.b17, plants: 1000 }],
    ...example(300),
  });
  const moves = sowLinkMovesForLine(plan.lines[0], { dispatchId: OID.s16, performedBy: null, now: new Date() });
  const x = moves.filter((m) => m.orderId === OID.X);
  assert.equal(x.length, 1);
  assert.equal(x[0].entry.plants, 1000);
  assert.equal(String(x[0].entry.fromBatchId), OID.b15);
  assert.equal(String(x[0].entry.batchId), OID.b17);
  const relinked = moves.filter((m) => m.entry.reason === "DISPATCH_RELINK");
  assert.deepEqual(relinked.map((m) => [m.orderId, m.entry.plants]), [
    [OID.Y3, 300],
    [OID.Y1, 400],
  ]);
});

test("switch summary text", () => {
  const plan = planSowBatchLoad({
    selections: [{ orderId: OID.X, batchId: OID.b17, plants: 1000 }],
    ...example(300),
  });
  const text = describeSowPlanLine(plan.lines[0], {
    batchDay: (id) => (id === OID.b17 ? "17 Oct" : "15 Oct"),
    orderCode: (id) => ({ [OID.Y1]: "4152", [OID.Y3]: "4160" })[id] || id,
  });
  assert.equal(
    text,
    "17 Oct: 300 excess + 700 from orders #4160, #4152. Those orders move to 15 Oct. 300 of 15 Oct become excess."
  );
});

test("mixed vehicle: every plant row must be loaded, one row can't cover another", () => {
  const dispatch = { plantsDetails: [{ quantity: 1000 }, { quantity: 500 }] };
  assert.equal(
    isVehicleLoadCompleteByRows(dispatch, { total: 1500, byRow: new Map([[0, 1500]]) }),
    false
  );
  assert.equal(
    isVehicleLoadCompleteByRows(dispatch, { total: 1490, byRow: new Map([[0, 1000], [1, 490]]) }),
    true
  );
  assert.equal(isVehicleLoadCompleteByRows({ plantsDetails: [] }, { total: 0, byRow: new Map() }), false);
});

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
  batchWithGridCover,
  sowingsForDispatch,
  directSowingLoadPlan,
} from "../services/sowDispatchBatches.service.js";
import { dispatchBookableFree } from "../utility/sowingBatchExcessStamp.js";
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
  const byRequest = {
    _id: OID.X,
    numberOfPlants: 1000,
    sowingDoneRequestId: OID.r15,
    sowingCoverSources: [{ sowingRequestId: OID.r15, plants: 1000, sowingDate: "22-10-2026" }],
  };
  assert.deepEqual(baseOrderLinks(byRequest, index), [
    { slotId: OID.s15, batchId: OID.b15, plants: 1000 },
  ]);
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

test("watermelon free-plant gift stays on the linked batch and does not take other orders", () => {
  const ctx = example(0);
  ctx.orderLinks.set(OID.X, [{ slotId: OID.s15, batchId: OID.b15, plants: 11458 }]);
  ctx.batches.get(OID.b15).free = 0;
  ctx.batches.get(OID.b15).orders = [{ orderId: OID.Y1, plants: 12000, deliveryMs: 1, bookedMs: 1 }];
  const plan = planSowBatchLoad({
    selections: [{ orderId: OID.X, batchId: OID.b15, plants: 11548 }],
    gifts: new Map([[OID.X, 90]]),
    ...ctx,
  });
  assert.equal(plan.ok, true);
  const line = plan.lines[0];
  assert.equal(line.bucket, "COVER");
  assert.equal(line.cover, 11458);
  assert.equal(line.plants, 11548);
  assert.equal(line.fromFree, 0);
  assert.equal(line.relinks.length, 0);
  assert.equal((line.unlinkedTakes || []).length, 0);
  assert.equal(ctx.batches.get(OID.b15).orders[0].plants, 12000);
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

test("sellable plants left can go out when cover has no free and no other booking", () => {
  const ctx = example(0);
  ctx.batches.get(OID.b17).orders = [];
  ctx.batches.get(OID.b17).remaining = 800;
  const plan = planSowBatchLoad({
    selections: [{ orderId: OID.X, batchId: OID.b17, plants: 800 }],
    ...ctx,
  });
  assert.equal(plan.ok, true);
  assert.equal(plan.lines[0].fromRemaining, true);
  assert.equal(plan.lines[0].relinks.length, 0);
  assert.equal(plan.lines[0].coverRehome.length, 0);

  ctx.batches.get(OID.b17).remaining = 100;
  const over = planSowBatchLoad({
    selections: [{ orderId: OID.X, batchId: OID.b17, plants: 800 }],
    ...ctx,
  });
  assert.equal(over.ok, true);
  assert.equal(over.lines[0].plants, 800);
  assert.equal(over.lines[0].fromRemaining, true);
});

test("a short sowing still loads and the plant count is not checked again as free plants", () => {
  const batches = new Map([
    ["a", { remaining: 100, slotId: "" }],
    ["b", { remaining: 40, slotId: "" }],
  ]);
  const plan = directSowingLoadPlan(
    [
      { orderId: "o1", batchId: "a", plants: 1000 },
      { orderId: "o1", batchId: "b", plants: 50 },
    ],
    batches
  );
  assert.equal(plan.ok, true);
  assert.deepEqual(
    plan.lines.map((line) => [line.batchId, line.plants]),
    [
      ["a", 1000],
      ["b", 50],
    ]
  );
  assert.equal(plan.lines[0].warnings.length, 1);
  assert.equal(plan.lines[1].fromFree, 0);
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
  assert.equal(b17.shownExcess, 0);
  assert.equal(b17.excessAllocations[0].plants, 300);
  assert.equal(b15.orderCoveredPlants, 3300);
  assert.equal(b15.excessPlants, 700);
  assert.equal(b15.shownExcess, 700);
  assert.equal(s15.availablePlants, 700);
  assert.equal(s15.orderReservedPlants, 3300);
  assert.equal(s15.excessiveSowing.plants, 700);
  assert.deepEqual(res, { reservedDec: 1000, availableDec: 0, touchedSlots: res.touchedSlots });
  assert.equal(s17.availablePlants, 0);
  assert.equal(s17.orderReservedPlants, 3000);
  // Picked batch lists the order for cover (Dispatched tag); original sow identity stays on sowBatchLinks.
  assert.ok(b17.linkedOrderIds.some((x) => String(x) === OID.X));
  assert.ok(b15.linkedOrderIds.some((x) => String(x) === OID.Y1));
  // Day-25 (own) excess ↑ leftover; day-22 (picked) excess ↓ free take.
  assert.equal(b15.excessPlants, 700);
  assert.equal(b15.shownExcess, 700);
  assert.equal(b17.excessPlants, 0);
  assert.equal(b17.shownExcess, 0);
  const switchLog = (b15.changeLog || []).find((e) => e.kind === "DISPATCH_SWITCH");
  assert.ok(switchLog);
  assert.equal(switchLog.plants, -1000);
  const loadLog = (b17.changeLog || []).find((e) => e.kind === "DISPATCH_LOAD");
  assert.ok(loadLog);
  assert.equal(loadLog.plants, -700);
});

test("switch re-homes loading order cover onto picked batch", () => {
  const plan = planSowBatchLoad({
    selections: [{ orderId: OID.X, batchId: OID.b17, plants: 1000 }],
    ...example(300),
  });
  const line = plan.lines[0];
  assert.deepEqual(line.coverRehome.map((r) => [r.fromBatchId, r.plants]), [[OID.b15, 1000]]);
  const moves = sowLinkMovesForLine(line, { dispatchId: OID.s16, performedBy: null, now: new Date() });
  const x = moves.filter((m) => m.orderId === OID.X && m.entry.reason === "DISPATCH_SWITCH");
  assert.equal(x.length, 1);
  assert.equal(String(x[0].entry.fromBatchId), OID.b15);
  assert.equal(String(x[0].entry.batchId), OID.b17);
  assert.equal(x[0].entry.plants, 1000);
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

test("dispatch free is grid excess, not expected ready", () => {
  const oct15 = {
    plantsSowed: 47754,
    orderCoveredPlants: 0,
    sowingBufferPct: 12,
    sowingRequestId: "req15",
    requestNumber: "SR15",
  };
  assert.equal(dispatchBookableFree(oct15, 12), 42024);
  const covered = batchWithGridCover(oct15, [
    {
      _id: "o1",
      numberOfPlants: 21000,
      sowingCoverSources: [{ sowingRequestId: "req15", plants: 21000, batchId: "b15" }],
    },
  ]);
  assert.equal(covered.orderCoveredPlants, 21000);
  assert.equal(dispatchBookableFree(covered, 12), 21024);

  const sep26 = batchWithGridCover(
    {
      plantsSowed: 24822,
      orderCoveredPlants: 0,
      sowingBufferPct: 12,
      sowingRequestId: "req26",
    },
    [
      {
        _id: "o2",
        numberOfPlants: 11458,
        sowingCoverSources: [{ sowingRequestId: "req26", plants: 23458 }],
      },
    ]
  );
  assert.equal(dispatchBookableFree(sep26, 12), 0);
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

test("dispatch keeps every sowing that still has plants, including one that is not the biggest", () => {
  const rows = sowingsForDispatch(
    [
      { batchId: "big", requestNumber: "SR-BIG", availablePlants: 16000, plantReadyDate: "20-11-2026" },
      { batchId: "sr4", requestNumber: "SR202610240004", availablePlants: 3500, plantReadyDate: "01-11-2026" },
      { batchId: "empty", requestNumber: "SR-EMPTY", availablePlants: 0, plantReadyDate: "15-11-2026" },
    ],
    [{ linked: [{ batchId: "sr4" }] }]
  );
  assert.deepEqual(
    rows.map((row) => row.requestNumber),
    ["SR202610240004", "SR-BIG"]
  );
});

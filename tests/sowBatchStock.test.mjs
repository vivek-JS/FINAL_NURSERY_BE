import test from "node:test";
import assert from "node:assert/strict";
import {
  dispatchedNetOf,
  remainingOf,
  changeCountOf,
  linkedOrderIdSet,
  mergeStockChanges,
  dmyToYmd,
  isReadyNow,
  orderRemainingPlants,
  summarizeStockRows,
} from "../services/sowBatchStock.service.js";
import { groupByPlantVarietyDate, plantLetter, rollupDeliveryIntel, ymdInRange } from "../services/sowBatchStock.intel.js";

const OID = {
  o1: "650000000000000000000001",
  o2: "650000000000000000000002",
};

test("dispatchedNet sums signed dispatchLog plants", () => {
  const batch = {
    dispatchLog: [
      { plants: 1000, bucket: "COVER" },
      { plants: 400, bucket: "FREE" },
      { plants: -200, bucket: "UNLOAD" },
      { plants: -100, bucket: "RETURN" },
    ],
  };
  assert.equal(dispatchedNetOf(batch), 1100);
});

test("remaining is sowed minus destroyed minus net dispatch", () => {
  const batch = {
    plantsSowed: 10000,
    destroyedPlants: 500,
    dispatchLog: [
      { plants: 3000, bucket: "COVER" },
      { plants: -500, bucket: "RETURN" },
    ],
  };
  assert.equal(remainingOf(batch), 7000);
  assert.equal(remainingOf(batch, 2500), 7000);
});

test("remaining never goes negative", () => {
  assert.equal(
    remainingOf({ plantsSowed: 100, destroyedPlants: 40, dispatchLog: [{ plants: 90 }] }),
    0
  );
});

test("changeCount and linked ids include allocs", () => {
  const batch = {
    linkedOrderIds: [OID.o1],
    dispatchLog: [{ plants: 10, orderId: OID.o1 }],
    destroyLog: [{ plants: 2 }],
    excessAllocations: [{ orderId: OID.o2, plants: 50 }],
    slotHistory: [{ plantsSowed: 100 }],
  };
  assert.equal(changeCountOf(batch), 4);
  assert.deepEqual([...linkedOrderIdSet(batch)].sort(), [OID.o1, OID.o2].sort());
});

test("mergeStockChanges is newest first and signs destroy as negative", () => {
  const t1 = new Date("2026-10-18T10:00:00.000Z");
  const t2 = new Date("2026-10-19T10:00:00.000Z");
  const t3 = new Date("2026-10-20T10:00:00.000Z");
  const changes = mergeStockChanges({
    dispatchLog: [{ at: t2, plants: 800, bucket: "COVER", orderId: OID.o1 }],
    destroyLog: [{ at: t3, plants: 50, reason: "rot" }],
    excessAllocations: [{ at: t1, plants: 200, orderId: OID.o2 }],
    slotHistory: [],
  });
  assert.equal(changes.length, 3);
  assert.equal(changes[0].type, "destroy");
  assert.equal(changes[0].plants, -50);
  assert.equal(changes[1].type, "dispatch");
  assert.equal(changes[1].orderId, OID.o1);
  assert.equal(changes[2].type, "excessAlloc");
});

test("ready date compare uses DD-MM-YYYY vs IST ymd", () => {
  assert.equal(dmyToYmd("18-10-2026"), "2026-10-18");
  assert.equal(isReadyNow("18-10-2026", "2026-10-20"), true);
  assert.equal(isReadyNow("25-10-2026", "2026-10-20"), false);
  assert.equal(isReadyNow("", "2026-10-20"), false);
});

test("order remaining uses partial cover until sowingDone", () => {
  const o = {
    numberOfPlants: 20000,
    additionalPlants: 0,
    sowingDone: false,
    sowingPartialCover: [{ plants: 2300 }],
  };
  assert.equal(orderRemainingPlants(o), 17700);
  assert.equal(orderRemainingPlants({ ...o, sowingDone: true }), 0);
  assert.equal(orderRemainingPlants({ ...o, remainingPlants: 9000 }), 6700);
  assert.equal(
    orderRemainingPlants({ numberOfPlants: 14000, remainingPlants: 9000, sowingDone: false }),
    9000
  );
  assert.equal(
    orderRemainingPlants({ numberOfPlants: 12000, remainingPlants: 0, sowingDone: false }),
    0
  );
});

test("plant letter W for watermelon", () => {
  assert.equal(plantLetter("Watermelon"), "W");
  assert.equal(plantLetter("Ram Tarbuja"), "W");
  assert.equal(plantLetter("Papaya"), "P");
});

test("stock summary keeps irrelevant rows and omits their excess", () => {
  const summary = summarizeStockRows([
    { remaining: 1000, plantsSowed: 4000, covered: 2000, excess: 1500, destroyedPlants: 0, dispatchedNet: 0 },
    {
      remaining: 800,
      plantsSowed: 3000,
      covered: 0,
      excess: 3000,
      destroyedPlants: 0,
      dispatchedNet: 0,
      isIrrelevant: true,
    },
  ]);
  assert.equal(summary.batches, 2);
  assert.equal(summary.excess, 1500);
  assert.equal(summary.sowed, 7000);
});

test("delivery intel skips irrelevant excess", () => {
  const rows = rollupDeliveryIntel(
    [
      { plantId: "p", subtypeId: "s", plantName: "Watermelon", subtypeName: "Ram", plantsSowed: 5000, excess: 4000, isIrrelevant: true },
      { plantId: "p", subtypeId: "s", plantName: "Watermelon", subtypeName: "Ram", plantsSowed: 2000, excess: 500 },
    ],
    []
  );
  assert.equal(rows[0].sowed, 2000);
  assert.equal(rows[0].excess, 500);
  assert.equal(rows[0].batches, 1);
});

test("in-progress orders stay out of the short", () => {
  const rows = rollupDeliveryIntel(
    [{ plantId: "p", subtypeId: "s", plantName: "Watermelon", subtypeName: "Prachand", plantsSowed: 8000, excess: 2000 }],
    [
      { plantId: "p", subtypeId: "s", plants: 5000, inProgress: true },
      { plantId: "p", subtypeId: "s", plants: 3000 },
      { plantId: "p", subtypeId: "s", plants: 9000, sowingDone: true },
    ]
  );
  assert.equal(rows[0].notSownPlants, 3000);
  assert.equal(rows[0].inProgressPlants, 5000);
  assert.equal(rows[0].short, 0);
});

test("stock groups by plant, variety, and date", () => {
  const groups = groupByPlantVarietyDate(
    [
      {
        plantId: "p",
        subtypeId: "s",
        plantName: "Watermelon",
        subtypeName: "Prachand",
        plantReadyDate: "21-10-2026",
        plantsSowed: 10000,
        excess: 4000,
      },
      {
        plantId: "p",
        subtypeId: "s",
        plantName: "Watermelon",
        subtypeName: "Prachand",
        plantReadyDate: "21-10-2026",
        plantsSowed: 8000,
        excess: 8000,
        isIrrelevant: true,
      },
    ],
    [
      { plantId: "p", subtypeId: "s", cropName: "Watermelon", varietyName: "Prachand", plants: 1200, orderId: 4132, dateYmd: "2026-10-21" },
      { plantId: "p", subtypeId: "s", plants: 900, inProgress: true, dateYmd: "2026-10-21" },
    ]
  );
  const date = groups[0].varieties[0].dates[0];
  assert.equal(groups[0].plantName, "Watermelon");
  assert.equal(groups[0].varieties[0].subtypeName, "Prachand");
  assert.equal(date.label, "21 Oct 2026");
  assert.equal(date.excess, 4000);
  assert.equal(date.notSownPlants, 1200);
  assert.equal(date.notSownOrders[0].orderId, 4132);
  assert.equal(date.inProgressPlants, 900);
});

test("delivery intel short is orders minus sowed", () => {
  const rows = rollupDeliveryIntel(
    [{ plantId: "p", subtypeId: "s", plantName: "Watermelon", subtypeName: "Ram", plantsSowed: 8000, excess: 2000 }],
    [{ plantId: "p", subtypeId: "s", cropName: "Watermelon", varietyName: "Ram", plants: 12000 }]
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].letter, "W");
  assert.equal(rows[0].orderPlants, 12000);
  assert.equal(rows[0].sowed, 8000);
  assert.equal(rows[0].excess, 2000);
  assert.equal(rows[0].short, 4000);
  assert.equal(rows[0].notSownPlants, 12000);
  assert.equal(ymdInRange("2026-10-05", "2026-10-01", "2026-10-10"), true);
  assert.equal(ymdInRange("2026-10-11", "2026-10-01", "2026-10-10"), false);
});

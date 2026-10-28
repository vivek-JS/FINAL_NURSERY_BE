import test from "node:test";
import assert from "node:assert/strict";
import {
  SMART_SHEDS,
  batchSpaceHold,
  ceilingsFor,
  coverBatchId,
  cropOf,
  fortForShade,
  fortFromText,
  poolOf,
  shedRoom,
} from "../utility/smartShedSpace.js";

const panhalgad = SMART_SHEDS.find((s) => s.key === "panhalgad");

test("half a papaya shed leaves the other half for papaya or watermelon", () => {
  const room = shedRoom({
    papayaUsed: 910000,
    melonUsed: 0,
    papayaMax: panhalgad.papaya,
    melonMax: panhalgad.melon,
  });
  assert.equal(room.used, 0.5);
  assert.equal(room.over, false);
  assert.equal(room.papayaRoom, 910000);
  assert.equal(room.melonRoom, 2022750);
});

test("watermelon and muskmelon share one melon ceiling", () => {
  const room = shedRoom({
    papayaUsed: 0,
    melonUsed: 300000 + 15000,
    papayaMax: 300000,
    melonMax: 630000,
  });
  assert.ok(Math.abs(room.used - 315000 / 630000) < 1e-9);
  assert.equal(poolOf(cropOf("Muskmelon")), "melon");
  assert.equal(poolOf(cropOf("Watermelon")), "melon");
  assert.equal(poolOf(cropOf("Papaya")), "papaya");
  assert.equal(cropOf("खरबूज"), "muskmelon");
  assert.equal(cropOf("टरबुज"), "watermelon");
  assert.equal(cropOf("पपई"), "papaya");
  assert.equal(cropOf("Banana"), null);
});

test("a mix can overflow and then both rooms are zero", () => {
  const room = shedRoom({
    papayaUsed: 1820000,
    melonUsed: 1,
    papayaMax: 1820000,
    melonMax: 4045500,
  });
  assert.equal(room.over, true);
  assert.equal(room.papayaRoom, 0);
  assert.equal(room.melonRoom, 0);
});

test("fort name wins when the shade number belongs to another fort", () => {
  assert.equal(fortFromText("Panhalgad (पन्हाळगड) (12)").key, "panhalgad");
  assert.equal(fortFromText("Kondhana (कोंढाणा) (23)").key, "kondhana");
  assert.equal(fortFromText("23 no (विशाल गड)").key, "vishalgad");
  assert.equal(fortFromText("12 no (12 no)").key, "panhalgad");
  assert.equal(fortFromText("Salheri (15)").key, "salher");
  assert.equal(fortFromText("Panhalgad Kondhana"), null);
  assert.equal(fortForShade({ name: "23 no (विशाल गड)", number: "23" }).key, "vishalgad");
  assert.equal(fortForShade({ name: "", number: "14" }).key, "vishalgad");
});

test("shade ceilings override the config only when stored", () => {
  const fort = SMART_SHEDS.find((s) => s.key === "salher");
  assert.deepEqual(ceilingsFor(fort, null), { papayaMax: 282000, melonMax: 592000 });
  assert.deepEqual(ceilingsFor(fort, { smartCapacity: { papaya: 10, melon: 20 } }), {
    papayaMax: 10,
    melonMax: 20,
  });
});

test("partial truck frees only the loaded plants", () => {
  const hold = batchSpaceHold(
    {
      plantsSowed: 1200,
      dispatchLog: [{ orderId: "o1", plants: 400, bucket: "COVER" }],
    },
    [{ orderId: "o1", plants: 1000, out: false }]
  );
  assert.equal(hold.occupied, 800);
  assert.equal(hold.onOpen, 600);
  assert.equal(hold.noOrder, 200);
});

test("order out with no dispatch log frees that share and leaves the buffer", () => {
  const hold = batchSpaceHold({ plantsSowed: 1200, dispatchLog: [] }, [
    { orderId: "o1", plants: 1000, out: true },
  ]);
  assert.equal(hold.occupied, 200);
  assert.equal(hold.onOpen, 0);
  assert.equal(hold.noOrder, 200);
  assert.equal(hold.orderOut, 1000);
});

test("dispatch log and dispatched status do not free the same plants twice", () => {
  const hold = batchSpaceHold(
    {
      plantsSowed: 1200,
      dispatchLog: [{ orderId: "o1", plants: 1000, bucket: "COVER" }],
    },
    [{ orderId: "o1", plants: 1000, out: true }]
  );
  assert.equal(hold.occupied, 200);
  assert.equal(hold.noOrder, 200);
});

test("one order in two sheds frees only each shed's own cover", () => {
  const batch = (plants) => ({ plantsSowed: plants, dispatchLog: [] });
  const a = batchSpaceHold(batch(100), [{ orderId: "o1", plants: 100, out: true }]);
  const b = batchSpaceHold(batch(200), [{ orderId: "o1", plants: 200, out: true }]);
  assert.equal(a.occupied, 0);
  assert.equal(b.occupied, 0);
  assert.equal(a.orderOut, 100);
  assert.equal(b.orderOut, 200);
});

test("cancel is not out, and an unload while the order is open comes back", () => {
  const cancelled = batchSpaceHold({ plantsSowed: 500 }, [{ orderId: "o1", plants: 500, out: false }]);
  assert.equal(cancelled.occupied, 500);
  assert.equal(cancelled.onOpen, 500);

  const unloaded = batchSpaceHold(
    {
      plantsSowed: 1000,
      dispatchLog: [
        { orderId: "o1", plants: 1000, bucket: "COVER" },
        { orderId: "o1", plants: -100, bucket: "UNLOAD" },
      ],
    },
    [{ orderId: "o1", plants: 1000, out: false }]
  );
  assert.equal(unloaded.occupied, 100);
  assert.equal(unloaded.onOpen, 100);
});

test("destroyed plants and unreceived rows do not hold space", () => {
  const destroyed = batchSpaceHold(
    { plantsSowed: 400, destroyedPlants: 400 },
    [{ orderId: "o1", plants: 400, out: false }]
  );
  assert.equal(destroyed.occupied, 0);
  const pending = batchSpaceHold({ plantsSowed: 400, readyPlantsReceived: false }, [
    { orderId: "o1", plants: 400, out: false },
  ]);
  assert.equal(pending.occupied, 0);
  assert.equal(pending.skipped, true);
});

test("moved cover is counted on the destination batch", () => {
  assert.equal(coverBatchId({ batchId: "src", moved: true, destBatchId: "dest" }), "dest");
  assert.equal(coverBatchId({ batchId: "src", moved: false, destBatchId: "dest" }), "src");
});

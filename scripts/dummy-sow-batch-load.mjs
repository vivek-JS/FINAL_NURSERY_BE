/**
 * Dummy sowing-batch load. Connects only to localhost and a throwaway database,
 * then drops that database. Does not read .env and does not touch nursery data.
 *
 *   node scripts/dummy-sow-batch-load.mjs
 */
import mongoose from "mongoose";
import PlantCms from "../models/plantCms.model.js";
import PlantSlot from "../models/slots.model.js";
import Order from "../models/order.model.js";
import Dispatch from "../models/dispatch.model.js";
import Farmer from "../models/farmer.model.js";
import User from "../models/user.model.js";
import Tray from "../models/tray.model.js";
import PlantOutward from "../models/plantOutward.model.js";
import DispatchBatch from "../models/dispatchBatch.model.js";
import {
  listSowBatchOptionsForDispatch,
  previewSowBatchLoad,
  executeSowBatchVehicleLoad,
} from "../services/sowDispatchBatches.service.js";
import { executeSecondaryVehicleUnload } from "../services/secondaryVehicleUnload.service.js";

const DB = "sow_dispatch_dummy_only";
const URL = process.env.SOW_DUMMY_MONGO_URL || `mongodb://127.0.0.1:27018/${DB}`;

function assertLocalThrowaway(conn) {
  const host = conn.host || "";
  const name = conn.name || "";
  const local = host === "127.0.0.1" || host === "localhost";
  if (!local || name !== DB) {
    throw new Error(`Refusing to run: connected to ${host}/${name}, expected 127.0.0.1/${DB}`);
  }
}

function farmer(name, village) {
  return {
    name,
    village,
    taluka: "Dummy",
    district: "Dummy",
    stateName: "Maharashtra",
    talukaName: "Dummy",
    districtName: "Dummy",
    state: "MH",
  };
}

function slot(start, end, month, extra) {
  return {
    startDay: start,
    endDay: end,
    month,
    plantReadyDate: start,
    availablePlants: extra.availablePlants,
    orderReservedPlants: extra.orderReservedPlants,
    excessiveSowing: { plants: extra.availablePlants, packets: 0 },
    primarySowed: extra.plantsSowed,
    sowingBatches: [extra.batch],
  };
}

const snap = async (label, slotDocId) => {
  const doc = await PlantSlot.findById(slotDocId).lean();
  const orders = await Order.find({ publicOrderCode: { $in: ["9001", "9002", "9003"] } })
    .select("publicOrderCode sowBatchLinks")
    .lean();
  console.log(`\n${label}`);
  for (const st of doc.subtypeSlots) {
    for (const sl of st.slots) {
      const b = sl.sowingBatches[0];
      console.log(
        `  ${sl.plantReadyDate} reserved=${sl.orderReservedPlants} available=${sl.availablePlants} excess=${sl.excessiveSowing?.plants} covered=${b.orderCoveredPlants} batchExcess=${b.excessPlants} dispatchLog=${(b.dispatchLog || []).map((d) => `${d.bucket}:${d.plants}`).join(",") || "none"}`
      );
    }
  }
  for (const o of orders) {
    const links = (o.sowBatchLinks || []).map(
      (l) => `${l.reason} ${l.plants} ready ${l.plantReadyDate || "—"} by #${l.causedByOrderCode || "?"}`
    );
    console.log(`  order #${o.publicOrderCode} links: ${links.join(" | ") || "none"}`);
  }
};

await mongoose.connect(URL);
assertLocalThrowaway(mongoose.connection);
console.log(`Dummy database ${mongoose.connection.host}/${mongoose.connection.name} — dropping it first`);
await mongoose.connection.dropDatabase();
await Promise.all([
  User.init(),
  Farmer.init(),
  PlantCms.init(),
  Tray.init(),
  Order.init(),
  PlantSlot.init(),
  Dispatch.init(),
  PlantOutward.init(),
  DispatchBatch.init(),
]);

try {
  const sales = await User.create({
    name: "Dummy Sales",
    phoneNumber: 9000000001,
    password: "dummy",
  });
  const [fx, fy3, fy1] = await Farmer.create([
    farmer("Dummy X", "Wai"),
    farmer("Dummy Y3", "Satara"),
    farmer("Dummy Y1", "Pune"),
  ]);
  const plant = await PlantCms.create({
    name: "Dummy Watermelon",
    sowingAllowed: true,
    slotSize: 1,
    subtypes: [
      {
        name: "Sugar Queen",
        slotDays: 1,
        slotStartDate: "01-10-2026",
        slotEndDate: "31-10-2026",
        slotCapacity: 4000,
        plantReadyDays: 20,
      },
    ],
  });
  const subtypeId = plant.subtypes[0]._id;
  const tray = await Tray.create({ name: "Dummy 104", cavity: 104, numberPerCrate: 1 });

  const req15 = new mongoose.Types.ObjectId();
  const req17 = new mongoose.Types.ObjectId();
  const batch15 = new mongoose.Types.ObjectId();
  const batch17 = new mongoose.Types.ObjectId();

  const x = await Order.create({
    orderId: 9001,
    publicOrderCode: "9001",
    farmer: fx._id,
    salesPerson: sales._id,
    plantName: plant._id,
    plantSubtype: subtypeId,
    bookingSlot: new mongoose.Types.ObjectId(),
    numberOfPlants: 1000,
    rate: 1,
    orderStatus: "ACCEPTED",
    payment: [],
    deliveryDate: new Date("2026-10-18"),
    orderBookingDate: new Date("2026-10-01"),
    sowingDone: true,
    sowingDoneRequestId: req15,
  });
  const y3 = await Order.create({
    orderId: 9003,
    publicOrderCode: "9003",
    farmer: fy3._id,
    salesPerson: sales._id,
    plantName: plant._id,
    plantSubtype: subtypeId,
    bookingSlot: new mongoose.Types.ObjectId(),
    numberOfPlants: 300,
    rate: 1,
    orderStatus: "ACCEPTED",
    payment: [],
    deliveryDate: new Date("2026-10-20"),
    orderBookingDate: new Date("2026-10-02"),
    sowingDone: true,
    sowingDoneRequestId: req17,
  });
  const y1 = await Order.create({
    orderId: 9002,
    publicOrderCode: "9002",
    farmer: fy1._id,
    salesPerson: sales._id,
    plantName: plant._id,
    plantSubtype: subtypeId,
    bookingSlot: new mongoose.Types.ObjectId(),
    numberOfPlants: 2000,
    rate: 1,
    orderStatus: "ACCEPTED",
    payment: [],
    deliveryDate: new Date("2026-10-22"),
    orderBookingDate: new Date("2026-10-03"),
    sowingDone: true,
    sowingDoneRequestId: req17,
  });

  const plantSlot = await PlantSlot.create({
    plantId: plant._id,
    year: 2026,
    subtypeSlots: [
      {
        subtypeId,
        slots: [
          slot("15-10-2026", "15-10-2026", "October", {
            availablePlants: 400,
            orderReservedPlants: 3600,
            plantsSowed: 4000,
            batch: {
              _id: batch15,
              sowingDate: "25-09-2026",
              plantReadyDate: "15-10-2026",
              plantsSowed: 4000,
              orderCoveredPlants: 3600,
              excessPlants: 400,
              noMortalityReserve: true,
              sowingRequestId: req15,
              requestNumber: "SR-DUMMY-15",
              shedName: "Dummy Shed A",
              linkedOrderIds: [x._id],
            },
          }),
          slot("17-10-2026", "17-10-2026", "October", {
            availablePlants: 300,
            orderReservedPlants: 3700,
            plantsSowed: 4000,
            batch: {
              _id: batch17,
              sowingDate: "27-09-2026",
              plantReadyDate: "17-10-2026",
              plantsSowed: 4000,
              orderCoveredPlants: 3700,
              excessPlants: 300,
              noMortalityReserve: true,
              sowingRequestId: req17,
              requestNumber: "SR-DUMMY-17",
              shedName: "Dummy Shed B",
              linkedOrderIds: [y3._id, y1._id],
            },
          }),
        ],
      },
    ],
  });

  const dispatch = await Dispatch.create({
    transportId: "DUMMY-SOW-1",
    transportStatus: "PENDING",
    driverName: "Dummy Driver",
    vehicleName: "Dummy Tempo",
    orderIds: [x._id],
    orderDispatchDetails: [
      {
        orderId: x._id,
        dispatchQuantity: 2000,
        remainingAfterDispatch: 0,
        shedLoadedQuantity: 0,
      },
    ],
    plantsDetails: [
      {
        name: "Dummy Watermelon",
        id: "dummy",
        plantId: plant._id,
        subTypeId: subtypeId,
        quantity: 2000,
        totalPlants: 2000,
        crates: [{ cavity: tray._id, cavityName: "104", crateCount: 1, plantCount: 2000 }],
      },
    ],
  });

  const options = await listSowBatchOptionsForDispatch(dispatch._id, 0);
  const xOpt = options.orders.find((o) => o.orderCode === "9001");
  console.log(
    `Linked default for #9001: ${(xOpt?.linked || []).map((l) => `${l.plantReadyDate} (${l.linkedPlants})`).join(", ") || "none"}`
  );
  console.log(`Batches offered: ${options.batches.map((b) => `${b.plantReadyDate} free ${b.freePlants} booked ${b.bookedForOthers}`).join(" | ")}`);

  const preview = await previewSowBatchLoad({
    dispatchId: dispatch._id,
    plantRowIndex: 0,
    sowBatchSelections: [{ orderId: x._id, slotId: plantSlot.subtypeSlots[0].slots[1]._id, batchId: batch17, plants: 1000 }],
  });
  console.log(`Preview: ${preview.lines[0].summary}`);
  console.log(`Warnings: ${(preview.warnings || []).join(" | ") || "none"}`);

  await snap("Before load", plantSlot._id);

  const loaded = await executeSowBatchVehicleLoad({
    dispatchId: dispatch._id,
    plantRowIndex: 0,
    sowBatchSelections: [{ orderId: String(x._id), batchId: String(batch17), plants: 1000 }],
  });
  console.log(`\nLoaded ${loaded.totalLoaded} as ${loaded.allocations[0].bucket}. ${loaded.allocations[0].summary}`);

  await snap("After switch load", plantSlot._id);

  const outwardId = loaded.allocations[0].secondaryOutwardId;
  await executeSecondaryVehicleUnload({
    dispatchId: dispatch._id,
    linkedOrderId: x._id,
    outwardSelections: [{ secondaryOutwardId: outwardId, plants: 1000 }],
  });

  await snap("After unload (relinks stay; only the 1000 dispatch is reversed)", plantSlot._id);

  const after = await PlantSlot.findById(plantSlot._id).lean();
  const s15 = after.subtypeSlots[0].slots.find((s) => s.plantReadyDate === "15-10-2026");
  const s17 = after.subtypeSlots[0].slots.find((s) => s.plantReadyDate === "17-10-2026");
  const y3After = await Order.findById(y3._id).select("sowBatchLinks").lean();
  const y1After = await Order.findById(y1._id).select("sowBatchLinks").lean();
  const b17 = s17.sowingBatches[0];
  const checks = [
    ["15 Oct keeps the 300 released excess (reserved 3300)", s15.orderReservedPlants === 3300],
    ["15 Oct available stays 700", s15.availablePlants === 700],
    ["17 Oct dispatch 1000 is back in reserve (4000)", s17.orderReservedPlants === 4000],
    ["17 Oct excess stays inside the reserve (available 0)", s17.availablePlants === 0],
    ["17 Oct unload is logged", (b17.dispatchLog || []).some((d) => d.bucket === "UNLOAD" && d.plants === -1000)],
    ["#9003 still relinked", (y3After.sowBatchLinks || []).some((l) => l.reason === "DISPATCH_RELINK")],
    ["#9002 still relinked", (y1After.sowBatchLinks || []).some((l) => l.reason === "DISPATCH_RELINK")],
  ];
  console.log("\nChecks");
  let failed = 0;
  for (const [name, ok] of checks) {
    console.log(`  ${ok ? "ok" : "FAIL"} ${name}`);
    if (!ok) failed += 1;
  }
  if (failed) process.exitCode = 1;
} finally {
  assertLocalThrowaway(mongoose.connection);
  await mongoose.connection.dropDatabase();
  console.log(`\nDropped ${mongoose.connection.name}. Real nursery data was not used.`);
  await mongoose.disconnect();
}

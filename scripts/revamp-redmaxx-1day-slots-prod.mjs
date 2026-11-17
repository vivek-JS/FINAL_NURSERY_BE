/**
 * RedMaxx: 7-day weeks → 1-day calendar like other watermelon (SImbha).
 * Remap orders to delivery day; move sown batch to ready day 06-11-2026.
 *
 *   node scripts/revamp-redmaxx-1day-slots-prod.mjs
 *   CONFIRM_PROD=YES node scripts/revamp-redmaxx-1day-slots-prod.mjs --apply
 */
import dotenv from "dotenv";
import mongoose from "mongoose";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "..", ".env") });

const APPLY = process.argv.includes("--apply");
if (APPLY && process.env.CONFIRM_PROD !== "YES") {
  console.error("Refusing PROD write without CONFIRM_PROD=YES");
  process.exit(1);
}

const PLANT_ID = new mongoose.Types.ObjectId("691054dffba6fb380f8d57b3");
const RED_ID = new mongoose.Types.ObjectId("6ad1f1421a53e268fc3f417f");
const SIM_ID = new mongoose.Types.ObjectId("6947709674defc113bd11fb4");
const YEARS = [2026, 2027];
const READY_DAYS = 18;
const CAP = 1;

function istYmd(d) {
  return new Date(d).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
}
function ymdToDdMmYyyy(ymd) {
  const [y, m, d] = String(ymd).split("-");
  return `${d}-${m}-${y}`;
}
function deliverySlotDay(deliveryDate) {
  return ymdToDdMmYyyy(istYmd(deliveryDate));
}

function emptyDay(src) {
  return {
    _id: new mongoose.Types.ObjectId(),
    excessiveSowing: { packets: 0, plants: 0 },
    rolledInActualReadyPlants: 0,
    orderReservedPlants: 0,
    rolledInAvailablePlants: 0,
    availablePlantsMaterialized: false,
    actualPlants: 0,
    closingStock: 0,
    startDay: src.startDay,
    endDay: src.startDay,
    totalPlants: CAP,
    totalBookedPlants: 0,
    availablePlants: CAP,
    buffer: 0,
    effectiveBuffer: 0,
    bufferAdjustedCapacity: CAP,
    bufferAmount: 0,
    originalTotalPlants: CAP,
    isOverflow: false,
    orders: [],
    allowedSalesmen: [],
    restrictToSalesmen: false,
    overflow: false,
    status: true,
    month: src.month || "",
    isManual: false,
    plantReadyDays: READY_DAYS,
    plantsSowed: 0,
    officeSowed: 0,
    primarySowed: 0,
    sowingDate: null,
    plantReadyDate: null,
    reminderBeforePlantReadyDays: 0,
    sowingCompleted: false,
    linkedSowingRequests: [],
    gapFullyCovered: false,
    sowingInProgress: [],
    gapCovered: [],
    productStock: [],
    slotTrail: [],
    actualReadyPlants: 0,
    expectedMortality: 0,
    lagwadRemaining: 0,
    sowingBatches: [],
    ...(src.year ? { year: src.year } : {}),
  };
}

await mongoose.connect(process.env.PROD_MONGO_URL, {
  serverSelectionTimeoutMS: 40000,
});
const db = mongoose.connection.db;
try {
  const plants = db.collection("plantcms");
  const slotsCol = db.collection("plantslots");
  const ordersCol = db.collection("orders");
  const reqsCol = db.collection("sowingrequests");

  const plant = await plants.findOne({ _id: PLANT_ID });
  const red = (plant.subtypes || []).find((s) => String(s._id) === String(RED_ID));
  if (!red || !/redmaxx/i.test(red.name)) throw new Error("RedMaxx CMS missing");

  const orders = await ordersCol
    .find({ plantSubtype: RED_ID })
    .project({
      orderId: 1,
      numberOfPlants: 1,
      additionalPlants: 1,
      bookingSlot: 1,
      deliveryDate: 1,
      sowingDone: 1,
      orderStatus: 1,
    })
    .toArray();

  const remap = orders.map((o) => ({
    _id: o._id,
    orderId: o.orderId,
    plants: (o.numberOfPlants || 0) + (o.additionalPlants || 0),
    fromSlot: String(o.bookingSlot || ""),
    toDay: deliverySlotDay(o.deliveryDate),
    sowingDone: Boolean(o.sowingDone),
  }));

  const cmsSet = {
    "subtypes.$.slotDays": 1,
    "subtypes.$.slotStartDate": "01-01-2026",
    "subtypes.$.slotEndDate": "31-12-2027",
    "subtypes.$.slotCapacity": CAP,
    "subtypes.$.buffer": 12,
  };
  console.log(
    APPLY ? "APPLY RedMaxx 1-day" : "DRY-RUN RedMaxx 1-day",
    `CMS slotDays ${red.slotDays}→1 cap ${red.slotCapacity}→${CAP}`
  );
  console.log("ORDER REMAP", remap);

  const plan = { years: {}, remap, sownMove: null };

  for (const year of YEARS) {
    const doc = await slotsCol.findOne(
      { plantId: PLANT_ID, year },
      { projection: { "subtypeSlots.subtypeId": 1, "subtypeSlots.slots._id": 1, "subtypeSlots.slots.startDay": 1, "subtypeSlots.slots.endDay": 1, "subtypeSlots.slots.month": 1, "subtypeSlots.slots.year": 1, "subtypeSlots.slots.totalBookedPlants": 1, "subtypeSlots.slots.primarySowed": 1, "subtypeSlots.slots.plantsSowed": 1, "subtypeSlots.slots.actualPlants": 1, "subtypeSlots.slots.expectedMortality": 1, "subtypeSlots.slots.orderReservedPlants": 1, "subtypeSlots.slots.availablePlants": 1, "subtypeSlots.slots.totalPlants": 1, "subtypeSlots.slots.excessiveSowing": 1, "subtypeSlots.slots.sowingDate": 1, "subtypeSlots.slots.plantReadyDate": 1, "subtypeSlots.slots.plantReadyDays": 1, "subtypeSlots.slots.linkedSowingRequests": 1, "subtypeSlots.slots.sowingBatches": 1, "subtypeSlots.slots.orders": 1 } }
    );
    if (!doc) throw new Error(`plantslots missing ${year}`);
    const sim = (doc.subtypeSlots || []).find((s) => String(s.subtypeId) === String(SIM_ID));
    const cur = (doc.subtypeSlots || []).find((s) => String(s.subtypeId) === String(RED_ID));
    if (!sim?.slots?.length) throw new Error(`SImbha template missing ${year}`);

    const days = sim.slots.map((s) => emptyDay(s));
    const byDay = new Map(days.map((s) => [s.startDay, s]));

    const sownOld = (cur?.slots || []).find((s) => (s.primarySowed || 0) > 0 || (s.sowingBatches || []).length);
    if (sownOld && year === 2026) {
      const readyDay = sownOld.plantReadyDate || "06-11-2026";
      const dest = byDay.get(readyDay);
      if (!dest) throw new Error(`no 1-day slot for ready ${readyDay}`);
      dest.primarySowed = sownOld.primarySowed || 0;
      dest.plantsSowed = sownOld.plantsSowed || sownOld.primarySowed || 0;
      dest.officeSowed = 0;
      dest.actualPlants = sownOld.actualPlants || 0;
      dest.expectedMortality = sownOld.expectedMortality || 0;
      dest.orderReservedPlants = sownOld.orderReservedPlants || 0;
      dest.excessiveSowing = sownOld.excessiveSowing || { packets: 0, plants: 0 };
      dest.sowingDate = sownOld.sowingDate || null;
      dest.plantReadyDate = readyDay;
      dest.plantReadyDays = READY_DAYS;
      dest.sowingBatches = sownOld.sowingBatches || [];
      dest.linkedSowingRequests = sownOld.linkedSowingRequests || [];
      dest.sowingCompleted = true;
      dest.totalPlants = CAP + (dest.plantsSowed || 0);
      dest.availablePlants = Math.max(CAP, Number(sownOld.availablePlants) || CAP) > 1000
        ? CAP
        : Number(sownOld.availablePlants) || CAP;
      plan.sownMove = {
        from: `${sownOld.startDay}→${sownOld.endDay}`,
        to: readyDay,
        plants: dest.plantsSowed,
        batchReq: dest.sowingBatches[0]?.requestNumber,
        newSlotId: String(dest._id),
      };
    }

    for (const row of remap) {
      const y = Number(String(row.toDay).slice(-4));
      if (y !== year) continue;
      const dest = byDay.get(row.toDay);
      if (!dest) throw new Error(`no 1-day slot ${row.toDay} for order ${row.orderId}`);
      dest.totalBookedPlants += row.plants;
      dest.orders.push(row._id);
      row.toSlotId = String(dest._id);
    }

    plan.years[year] = {
      oldSlots: (cur?.slots || []).length,
      newSlots: days.length,
      bookedDays: days.filter((s) => s.totalBookedPlants > 0).map((s) => ({
        day: s.startDay,
        booked: s.totalBookedPlants,
        orders: s.orders.length,
        sowed: s.primarySowed,
      })),
    };

    if (APPLY) {
      await slotsCol.updateOne(
        { _id: doc._id, "subtypeSlots.subtypeId": RED_ID },
        { $set: { "subtypeSlots.$.slots": days } }
      );
    }
  }

  if (APPLY) {
    await plants.updateOne({ _id: PLANT_ID, "subtypes._id": RED_ID }, { $set: cmsSet });
    for (const row of remap) {
      if (!row.toSlotId) continue;
      await ordersCol.updateOne(
        { _id: row._id },
        { $set: { bookingSlot: new mongoose.Types.ObjectId(row.toSlotId) } }
      );
    }
    if (plan.sownMove?.batchReq) {
      await reqsCol.updateOne(
        { requestNumber: plan.sownMove.batchReq },
        { $set: { linkedSlotIds: [new mongoose.Types.ObjectId(plan.sownMove.newSlotId)] } }
      );
    }
  }

  const backupDir = path.resolve(__dirname, "../../dryrun-reports");
  fs.mkdirSync(backupDir, { recursive: true });
  const file = path.join(backupDir, `redmaxx-1day-${APPLY ? "apply" : "dry"}-${Date.now()}.json`);
  fs.writeFileSync(file, JSON.stringify(plan, null, 2));
  console.log(JSON.stringify(plan, null, 2));
  console.log("wrote", file);
} finally {
  await mongoose.disconnect();
}

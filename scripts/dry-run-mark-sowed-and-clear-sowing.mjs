/**
 * DRY RUN — mark DISPATCHED/COMPLETED/DISPATCH_PROCESS orders as sowingDone,
 * then remove all sowing records (Sowing + SowingRequest) and reset slot sow fields.
 *
 *   node scripts/dry-run-mark-sowed-and-clear-sowing.mjs
 *   node scripts/dry-run-mark-sowed-and-clear-sowing.mjs --from=2026-07-01
 *
 * Apply (only after review):
 *   node scripts/dry-run-mark-sowed-and-clear-sowing.mjs --apply
 */
import dotenv from "dotenv";
import mongoose from "mongoose";
import path from "path";
import { fileURLToPath } from "url";
import PlantCms from "../models/plantCms.model.js";
import Order from "../models/order.model.js";
import Sowing from "../models/sowing.model.js";
import SowingRequest from "../models/sowingRequest.model.js";
import RaisingSeedIntake from "../models/raisingSeedIntake.model.js";
import PlantSlot from "../models/slots.model.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "../.env") });

const APPLY = process.argv.includes("--apply");
const fromArg = process.argv.find((a) => a.startsWith("--from="));
const FROM = fromArg ? fromArg.split("=")[1] : null;

const MARK_STATUSES = ["DISPATCHED", "COMPLETED", "DISPATCH_PROCESS"];
const fmt = (n) => Number(n || 0).toLocaleString("en-IN");

function istDayStart(isoYmd) {
  const [y, m, d] = isoYmd.split("-").map(Number);
  const IST = 5.5 * 60 * 60 * 1000;
  return new Date(Date.UTC(y, m - 1, d, 0, 0, 0, 0) - IST);
}

/** Slots with any sowing-related counters (nested subtypeSlots.slots). */
const SLOT_SOWING_MATCH = {
  $or: [
    { "subtypeSlots.slots.plantsSowed": { $gt: 0 } },
    { "subtypeSlots.slots.officeSowed": { $gt: 0 } },
    { "subtypeSlots.slots.primarySowed": { $gt: 0 } },
    { "subtypeSlots.slots.actualPlants": { $gt: 0 } },
    { "subtypeSlots.slots.availablePlants": { $gt: 0 } },
    { "subtypeSlots.slots.orderReservedPlants": { $gt: 0 } },
    { "subtypeSlots.slots.excessiveSowing.plants": { $gt: 0 } },
    { "subtypeSlots.slots.sowingInProgress.0": { $exists: true } },
    { "subtypeSlots.slots.sowingDate": { $exists: true, $nin: [null, ""] } },
    { "subtypeSlots.slots.plantReadyDate": { $exists: true, $nin: [null, ""] } },
  ],
};

async function orderMarkPreview(extraMatch = {}) {
  const match = {
    orderStatus: { $in: MARK_STATUSES },
    sowingDone: { $ne: true },
    ...extraMatch,
  };
  const agg = await Order.aggregate([
    { $match: match },
    {
      $group: {
        _id: "$orderStatus",
        orders: { $sum: 1 },
        plants: {
          $sum: {
            $add: [
              { $ifNull: ["$numberOfPlants", 0] },
              { $ifNull: ["$additionalPlants", 0] },
            ],
          },
        },
      },
    },
    { $sort: { _id: 1 } },
  ]);
  const total = await Order.countDocuments(match);
  return { agg, total };
}

async function slotSowingStats(plantIds = null) {
  const match = plantIds?.length
    ? { plantId: { $in: plantIds }, ...SLOT_SOWING_MATCH }
    : SLOT_SOWING_MATCH;

  const docs = await PlantSlot.countDocuments(match);

  const totals = await PlantSlot.aggregate([
    { $match: match },
    { $unwind: "$subtypeSlots" },
    { $unwind: "$subtypeSlots.slots" },
    {
      $group: {
        _id: null,
        actualPlants: { $sum: { $ifNull: ["$subtypeSlots.slots.actualPlants", 0] } },
        availablePlants: { $sum: { $ifNull: ["$subtypeSlots.slots.availablePlants", 0] } },
        orderReserved: { $sum: { $ifNull: ["$subtypeSlots.slots.orderReservedPlants", 0] } },
        primarySowed: { $sum: { $ifNull: ["$subtypeSlots.slots.primarySowed", 0] } },
        plantsSowed: { $sum: { $ifNull: ["$subtypeSlots.slots.plantsSowed", 0] } },
        excessPlants: {
          $sum: { $ifNull: ["$subtypeSlots.slots.excessiveSowing.plants", 0] },
        },
        slotDays: { $sum: 1 },
      },
    },
  ]);

  return { plantSlotDocs: docs, totals: totals[0] || {} };
}

async function main() {
  console.log(APPLY ? "=== APPLY MODE ===" : "=== DRY RUN (no writes) ===");
  console.log(
    "Plan:\n" +
      "  1. Set sowingDone=true on DISPATCHED + COMPLETED + DISPATCH_PROCESS (not yet sowed)\n" +
      "  2. Delete all Sowing + SowingRequest documents\n" +
      "  3. Reset sowing counters on calendar slots\n" +
      "  4. RaisingSeedIntake: NOT deleted (farmer seed records kept)\n"
  );

  await mongoose.connect(process.env.PROD_MONGO_URL);

  const plants = await PlantCms.find({ sowingAllowed: true })
    .select("name")
    .lean();
  const sowingPlantIds = plants.map((p) => p._id);
  const realPlantIds = plants
    .filter((p) => !["Dummy", "Sow test"].includes(p.name))
    .map((p) => p._id);

  // ── Step 1: orders to mark ──
  console.log("── STEP 1: Mark orders sowingDone ──\n");

  const globalPreview = await orderMarkPreview();
  console.log("ALL orders (any plant):");
  for (const r of globalPreview.agg) {
    console.log(`  ${r._id}: ${r.orders} orders · ${fmt(r.plants)} plants to mark`);
  }
  console.log(`  TOTAL to mark: ${globalPreview.total} orders\n`);

  const sowingAllowedPreview = await orderMarkPreview({
    plantName: { $in: realPlantIds },
  });
  console.log("Sowing-allowed plants only (excl Dummy/Sow test):");
  for (const r of sowingAllowedPreview.agg) {
    console.log(`  ${r._id}: ${r.orders} orders · ${fmt(r.plants)} plants`);
  }
  console.log(`  TOTAL: ${sowingAllowedPreview.total} orders\n`);

  if (FROM) {
    const fromDate = istDayStart(FROM);
    const fromPreview = await orderMarkPreview({
      plantName: { $in: realPlantIds },
      $or: [
        { orderBookingDate: { $gte: fromDate } },
        { orderBookingDate: null, createdAt: { $gte: fromDate } },
      ],
    });
    console.log(`Sowing-allowed + booked from ${FROM}:`);
    for (const r of fromPreview.agg) {
      console.log(`  ${r._id}: ${r.orders} orders · ${fmt(r.plants)} plants`);
    }
    console.log(`  TOTAL: ${fromPreview.total} orders\n`);
  }

  const alreadySowed = await Order.countDocuments({
    orderStatus: { $in: MARK_STATUSES },
    sowingDone: true,
  });
  console.log(`Already sowingDone in these statuses: ${alreadySowed} orders\n`);

  // Sample orders that would be marked
  const sample = await Order.find({
    orderStatus: { $in: MARK_STATUSES },
    sowingDone: { $ne: true },
    plantName: { $in: realPlantIds },
  })
    .select("orderId orderStatus numberOfPlants plantName sowingDone")
    .populate("plantName", "name")
    .limit(8)
    .lean();
  console.log("Sample orders to mark (max 8):");
  for (const o of sample) {
    console.log(
      `  #${o.orderId} · ${o.orderStatus} · ${fmt(o.numberOfPlants)} plants · ${o.plantName?.name || "?"}`
    );
  }
  console.log();

  // ── Step 2: delete sowing collections ──
  console.log("── STEP 2: Delete sowing entries ──\n");

  const sowingCount = await Sowing.countDocuments({});
  const reqCount = await SowingRequest.countDocuments({});
  const reqByStatus = await SowingRequest.aggregate([
    { $group: { _id: "$status", c: { $sum: 1 } } },
    { $sort: { c: -1 } },
  ]);
  const raisingCount = await RaisingSeedIntake.countDocuments({});

  console.log(`  Sowing (legacy) documents to DELETE:     ${sowingCount}`);
  console.log(`  SowingRequest documents to DELETE:        ${reqCount}`);
  for (const r of reqByStatus) {
    console.log(`    └ status ${r._id}: ${r.c}`);
  }
  console.log(`  RaisingSeedIntake (KEEP, not deleted):    ${raisingCount}\n`);

  // ── Step 3: slot reset ──
  console.log("── STEP 3: Reset slot sowing fields ──\n");

  const slotsAll = await slotSowingStats();
  const slotsSowingPlants = await slotSowingStats(sowingPlantIds);

  console.log("All plants — slot days with sow data:");
  console.log(`  PlantSlot documents: ${slotsAll.plantSlotDocs}`);
  console.log(`  Slot-days: ${slotsAll.totals.slotDays || 0}`);
  console.log(`  actualPlants sum: ${fmt(slotsAll.totals.actualPlants)}`);
  console.log(`  availablePlants sum: ${fmt(slotsAll.totals.availablePlants)}`);
  console.log(`  orderReservedPlants sum: ${fmt(slotsAll.totals.orderReserved)}`);
  console.log(`  primarySowed sum: ${fmt(slotsAll.totals.primarySowed)}`);
  console.log(`  excessiveSowing.plants sum: ${fmt(slotsAll.totals.excessPlants)}\n`);

  console.log("Sowing-allowed plants only:");
  console.log(`  PlantSlot documents: ${slotsSowingPlants.plantSlotDocs}`);
  console.log(`  actualPlants sum: ${fmt(slotsSowingPlants.totals.actualPlants)}`);
  console.log(`  availablePlants sum: ${fmt(slotsSowingPlants.totals.availablePlants)}\n`);

  // Orders already linked to sowing requests
  const linkedOrders = await Order.countDocuments({
    sowingDoneRequestId: { $exists: true, $ne: null },
  });
  console.log(`Orders with sowingDoneRequestId set: ${linkedOrders}`);
  console.log("(After delete, these refs would be orphaned unless cleared)\n");

  console.log("── NOT touched ──");
  console.log("  · Order plants / delivery / dispatch status");
  console.log("  · Inventory outward / return requests");
  console.log("  · RaisingSeedIntake (farmer seed collected)");
  console.log("  · totalBookedPlants on slots\n");

  if (!APPLY) {
    console.log("DRY RUN complete. Re-run with --apply to execute on PROD.");
    await mongoose.disconnect();
    return;
  }

  console.log("Applying changes...\n");

  const markResult = await Order.updateMany(
    {
      orderStatus: { $in: MARK_STATUSES },
      sowingDone: { $ne: true },
    },
    {
      $set: {
        sowingDone: true,
        sowingDoneAt: new Date(),
      },
      $unset: { sowingDoneRequestId: "" },
    }
  );

  const sowDel = await Sowing.deleteMany({});
  const reqDel = await SowingRequest.deleteMany({});

  // Reset nested slot fields via aggregation update is complex — use updateMany with array filters
  const slotReset = await PlantSlot.updateMany(SLOT_SOWING_MATCH, {
    $set: {
      "subtypeSlots.$[].slots.$[s].plantsSowed": 0,
      "subtypeSlots.$[].slots.$[s].officeSowed": 0,
      "subtypeSlots.$[].slots.$[s].primarySowed": 0,
      "subtypeSlots.$[].slots.$[s].actualPlants": 0,
      "subtypeSlots.$[].slots.$[s].availablePlants": 0,
      "subtypeSlots.$[].slots.$[s].orderReservedPlants": 0,
      "subtypeSlots.$[].slots.$[s].excessiveSowing.packets": 0,
      "subtypeSlots.$[].slots.$[s].excessiveSowing.plants": 0,
      "subtypeSlots.$[].slots.$[s].sowingCompleted": false,
      "subtypeSlots.$[].slots.$[s].sowingInProgress": [],
    },
    $unset: {
      "subtypeSlots.$[].slots.$[s].sowingDate": "",
      "subtypeSlots.$[].slots.$[s].plantReadyDate": "",
      "subtypeSlots.$[].slots.$[s].sowingCompletedDate": "",
    },
  }, {
    arrayFilters: [{}],
  });

  console.log(`Marked sowingDone: ${markResult.modifiedCount} orders`);
  console.log(`Deleted Sowing: ${sowDel.deletedCount}`);
  console.log(`Deleted SowingRequest: ${reqDel.deletedCount}`);
  console.log(`Slot docs matched: ${slotReset.matchedCount} · modified: ${slotReset.modifiedCount}`);

  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

/**
 * Dry run: SB178 lagwad 28 Aug → 20 Aug — undo old slot, relink, resync simulation.
 * Usage: node scripts/dry-run-sb178-lagwad-change.js
 * NO DB WRITES.
 */
import mongoose from "mongoose";
import dotenv from "dotenv";
import moment from "moment";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "../.env") });

import PlantOutward from "../models/plantOutward.model.js";
import DispatchBatch from "../models/dispatchBatch.model.js";
import PlantSlot from "../models/slots.model.js";
import { findDeliverySlotByDate } from "../utility/findDeliverySlot.js";
import {
  splitLagwadQtyForSlot,
  computeLagwadPendingSlotSync,
} from "../utility/lagwadSlotPlantsSplit.js";

const BATCH_NUMBER = "SB178";
const NEW_LAGWAD = "2026-08-20";

function fmt(n) {
  return Math.max(0, Math.floor(Number(n) || 0)).toLocaleString("en-IN");
}

function slotSnapshot(slot, label) {
  if (!slot) return { label, missing: true };
  return {
    label,
    slotId: String(slot._id),
    window: `${slot.startDay} – ${slot.endDay}`,
    actualPlants: Number(slot.actualPlants) || 0,
    actualReadyPlants: Number(slot.actualReadyPlants) || 0,
    expectedMortality: Number(slot.expectedMortality) || 0,
    lagwadRemaining: Number(slot.lagwadRemaining) || 0,
  };
}

function computeUndoDeltas(synced, avail) {
  const split = splitLagwadQtyForSlot(avail);
  const mortalityDec =
    split.actualPlants > 0
      ? Math.round((split.expectedMortality * synced) / split.actualPlants)
      : 0;
  return {
    actualDec: synced,
    mortalityDec,
    readyDec: synced,
  };
}

function computeSyncDeltas(avail, syncedBefore) {
  const lagwadSync = computeLagwadPendingSlotSync(avail, syncedBefore);
  const split = splitLagwadQtyForSlot(avail);
  const mortalityInc =
    split.actualPlants > 0
      ? Math.round(
          (split.expectedMortality * lagwadSync.pending) / split.actualPlants
        )
      : 0;
  return {
    pending: lagwadSync.pending,
    actualInc: lagwadSync.actualPlantsDelta,
    mortalityInc,
    readyInc: lagwadSync.readyDelta,
    syncedAfter: lagwadSync.syncedAfter,
  };
}

async function resolveSlotForReady(batchLean, readyDate) {
  const plantCmsId = batchLean.plantCmsId?._id ?? batchLean.plantCmsId;
  const plantSubtypeId = batchLean.plantSubtypeId?._id ?? batchLean.plantSubtypeId;
  try {
    const slot = await findDeliverySlotByDate(
      plantCmsId,
      plantSubtypeId,
      moment(readyDate).toDate()
    );
    return slot;
  } catch (e) {
    return null;
  }
}

async function main() {
  const uri = process.env.MONGO_URL || process.env.MONGODB_URI;
  if (!uri) throw new Error("No MONGO_URL");
  await mongoose.connect(uri);

  const batchLean = await DispatchBatch.findOne({ batchNumber: BATCH_NUMBER }).lean();
  if (!batchLean) throw new Error(`Batch ${BATCH_NUMBER} not found`);

  const po = await PlantOutward.findOne({ batchId: batchLean._id }).lean();
  const si = po?.secondaryInward?.[0];
  if (!si) throw new Error("No secondary inward for SB178");

  const secDays = Number(batchLean.secondaryPlantReadyDays) || 30;
  const avail = Math.max(0, Number(si.availableQuantity) || 0);
  const synced = Math.max(0, Number(si.slotStockSyncedPlants) || 0);
  const oldSlotId = String(si.linkedBookingSlotId);
  const inwardId = String(si._id);

  const curLagwad = moment(si.secondaryInwardDate).format("DD MMM YYYY");
  const curExpected = si.expectedReadyDate
    ? moment(si.expectedReadyDate).format("DD MMM YYYY")
    : moment(si.secondaryInwardDate).add(secDays, "days").format("DD MMM YYYY");

  const newLagwadM = moment(NEW_LAGWAD).startOf("day");
  const newExpected = newLagwadM.clone().add(secDays, "days");
  const newExpectedStr = newExpected.format("DD MMM YYYY");

  const oldSlotDoc = await PlantSlot.findOne({
    "subtypeSlots.slots._id": new mongoose.Types.ObjectId(oldSlotId),
  }).lean();
  let oldSlot = null;
  for (const st of oldSlotDoc?.subtypeSlots || []) {
    oldSlot = (st.slots || []).find((s) => String(s._id) === oldSlotId);
    if (oldSlot) break;
  }

  const newSlotLean = await resolveSlotForReady(batchLean, newExpected.toDate());
  let newSlot = null;
  if (newSlotLean?._id) {
    const newSlotDoc = await PlantSlot.findOne({
      "subtypeSlots.slots._id": newSlotLean._id,
    }).lean();
    for (const st of newSlotDoc?.subtypeSlots || []) {
      newSlot = (st.slots || []).find(
        (s) => String(s._id) === String(newSlotLean._id)
      );
      if (newSlot) break;
    }
  }

  const today = moment().startOf("day");
  const calendarReadyOnNew = today.isSameOrAfter(newExpected, "day");
  const calendarReadyOnCur = today.isSameOrAfter(
    moment(si.expectedReadyDate || moment(si.secondaryInwardDate).add(secDays, "days")),
    "day"
  );

  const undo = computeUndoDeltas(synced, avail);
  const resync = computeSyncDeltas(avail, 0);

  const col = mongoose.connection.collection("secondarydispatchledgerlines");
  const soldLines = await col
    .find({
      $or: [{ secondaryInwardId: inwardId }, { batchNumber: BATCH_NUMBER }],
      action: "LOAD",
    })
    .toArray();
  const soldTotal = soldLines.reduce(
    (s, l) => s + Math.max(0, Number(l.plantsAbs) || 0),
    0
  );

  console.log("\n╔══════════════════════════════════════════════════════════════╗");
  console.log("║  DRY RUN: SB178 lagwad change (NO DB WRITES)                 ║");
  console.log("╚══════════════════════════════════════════════════════════════╝\n");

  console.log("── INWARD LINE (current) ──");
  console.log(`  Batch:           ${BATCH_NUMBER}`);
  console.log(`  Inward id:       ${inwardId}`);
  console.log(`  Shed:            ${si.pollyhouse || "—"}`);
  console.log(`  Available:       ${fmt(avail)}`);
  console.log(`  Synced to slot:  ${fmt(synced)}`);
  console.log(`  Lagwad date:     ${curLagwad}  →  ${newLagwadM.format("DD MMM YYYY")}`);
  console.log(`  Expected ready:  ${curExpected}  →  ${newExpectedStr}`);
  console.log(`  Sold (ledger):   ${fmt(soldTotal)} (${soldLines.length} lines)`);

  console.log("\n── STEP 1: UNDO sync on OLD slot (24–30 Sep) ──");
  console.log(`  Slot before:     ${oldSlot?.startDay} – ${oldSlot?.endDay}`);
  console.log(`  id:              ${oldSlotId}`);
  console.log(
    JSON.stringify(slotSnapshot(oldSlot, "before undo"), null, 2)
      .split("\n")
      .map((l) => "  " + l)
      .join("\n")
  );
  const oldAfter = {
    actualPlants: (Number(oldSlot?.actualPlants) || 0) - undo.actualDec,
    actualReadyPlants: (Number(oldSlot?.actualReadyPlants) || 0) - undo.readyDec,
    expectedMortality:
      (Number(oldSlot?.expectedMortality) || 0) - undo.mortalityDec,
  };
  console.log("  Changes:");
  console.log(`    actualPlants:      −${fmt(undo.actualDec)}`);
  console.log(`    actualReadyPlants: −${fmt(undo.readyDec)}`);
  console.log(`    expectedMortality: −${fmt(undo.mortalityDec)}`);
  console.log("  Slot after undo:");
  console.log(`    actualPlants:      ${fmt(oldAfter.actualPlants)}`);
  console.log(`    actualReadyPlants: ${fmt(oldAfter.actualReadyPlants)}`);
  console.log(`    expectedMortality: ${fmt(oldAfter.expectedMortality)}`);

  console.log("\n── STEP 2: RELINK inward ──");
  console.log(`  linkedBookingSlotId: ${oldSlotId.slice(-8)}…  →  ${newSlot ? String(newSlot._id).slice(-8) + "…" : "NONE"}`);
  console.log(`  New slot window:     ${newSlot ? `${newSlot.startDay} – ${newSlot.endDay}` : "—"}`);
  console.log(`  expectedReadyDate:     ${newExpected.format("YYYY-MM-DD")}`);
  console.log(`  slotStockSyncedPlants: ${fmt(synced)} → 0 (reset before resync)`);

  console.log("\n── STEP 3: RESYNC on NEW slot (17–23 Sep) ──");
  console.log(
    `  Calendar ready today (${today.format("DD MMM YYYY")}): ${calendarReadyOnNew ? "YES — can sync now" : `NO — wait until ${newExpectedStr}`}`
  );
  console.log(
    JSON.stringify(slotSnapshot(newSlot, "before resync"), null, 2)
      .split("\n")
      .map((l) => "  " + l)
      .join("\n")
  );
  console.log("  Resync deltas (90% rule, synced from 0):");
  console.log(`    actualPlants:      +${fmt(resync.actualInc)}`);
  console.log(`    actualReadyPlants: +${fmt(resync.readyInc)}`);
  console.log(`    expectedMortality: +${fmt(resync.mortalityInc)}`);
  console.log(`    slotStockSyncedPlants on inward: 0 → ${fmt(resync.syncedAfter)}`);
  const newAfter = {
    actualPlants: (Number(newSlot?.actualPlants) || 0) + resync.actualInc,
    actualReadyPlants: (Number(newSlot?.actualReadyPlants) || 0) + resync.readyInc,
    expectedMortality:
      (Number(newSlot?.expectedMortality) || 0) + resync.mortalityInc,
  };
  console.log("  New slot after resync:");
  console.log(`    actualPlants:      ${fmt(newAfter.actualPlants)}`);
  console.log(`    actualReadyPlants: ${fmt(newAfter.actualReadyPlants)}`);
  console.log(`    expectedMortality: ${fmt(newAfter.expectedMortality)}`);

  console.log("\n── NET SUMMARY ──");
  console.log("  Slot (24–30 Sep):");
  console.log(`    Dispatch ready: ${fmt(oldSlot?.actualReadyPlants)} → ${fmt(oldAfter.actualReadyPlants)}`);
  console.log(`    Sowed:          ${fmt(oldSlot?.actualPlants)} → ${fmt(oldAfter.actualPlants)}`);
  console.log("  Slot (17–23 Sep):");
  console.log(`    Dispatch ready: ${fmt(newSlot?.actualReadyPlants)} → ${fmt(newAfter.actualReadyPlants)}`);
  console.log(`    Sowed:          ${fmt(newSlot?.actualPlants)} → ${fmt(newAfter.actualPlants)}`);
  console.log(`  Ready date moves: ${curExpected} → ${newExpectedStr} (${newExpected.diff(moment(si.expectedReadyDate), "days")} days)`);

  if (soldTotal > 0) {
    console.log("\n  ⚠ WARNING: batch has ledger sold — manual review before undo");
  }
  if (!calendarReadyOnNew) {
    console.log(`\n  ℹ Resync normally waits until ${newExpectedStr}; use force/mark-ready to sync earlier.`);
  }
  console.log("\n  ✓ Dry run complete — no changes written to DB.\n");

  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

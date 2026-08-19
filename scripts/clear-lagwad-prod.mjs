/**
 * Remove ALL secondary lagwad data from PROD:
 * - PlantOutward.secondaryInward + secondaryOutward (re-save summaries)
 * - SecondaryDispatchAvailability FIFO ledger
 * - Slot lagwad fields: actualPlants, expectedMortality, actualReadyPlants, lagwadRemaining
 *
 * Usage:
 *   node scripts/clear-lagwad-prod.mjs              # dry-run counts
 *   node scripts/clear-lagwad-prod.mjs --apply      # write PROD
 */
import dotenv from "dotenv";
import mongoose from "mongoose";
import path from "path";
import { fileURLToPath } from "url";
import PlantOutward from "../models/plantOutward.model.js";
import PlantSlot from "../models/slots.model.js";
import SecondaryDispatchAvailability from "../models/secondaryDispatchAvailability.model.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "../.env") });

const APPLY = process.argv.includes("--apply");

function uri() {
  const url = process.env.PROD_MONGO_URL;
  if (!url) throw new Error("PROD_MONGO_URL missing in FINAL_NURSERY_BE/.env");
  return url;
}

async function countLagwadOnSlots() {
  const docs = await PlantSlot.find({}).select("subtypeSlots").lean();
  let slots = 0;
  let withLagwadFields = 0;
  let sumActual = 0;
  let sumMortality = 0;
  let sumReady = 0;
  let sumLagwadRem = 0;

  for (const doc of docs) {
    for (const st of doc.subtypeSlots || []) {
      for (const slot of st.slots || []) {
        slots += 1;
        const a = Number(slot.actualPlants) || 0;
        const m = Number(slot.expectedMortality) || 0;
        const r = Number(slot.actualReadyPlants) || 0;
        const l = Number(slot.lagwadRemaining) || 0;
        sumActual += a;
        sumMortality += m;
        sumReady += r;
        sumLagwadRem += l;
        if (a > 0 || m > 0 || r > 0 || l > 0) withLagwadFields += 1;
      }
    }
  }

  return {
    plantSlotDocs: docs.length,
    slots,
    withLagwadFields,
    sumActual,
    sumMortality,
    sumReady,
    sumLagwadRem,
  };
}

async function clearPlantOutwards() {
  const filter = {
    $or: [
      { "secondaryInward.0": { $exists: true } },
      { "secondaryOutward.0": { $exists: true } },
    ],
  };

  const docs = await PlantOutward.find(filter).select(
    "batchId secondaryInward secondaryOutward"
  );

  let inwardLines = 0;
  let outwardLines = 0;
  for (const po of docs) {
    inwardLines += (po.secondaryInward || []).length;
    outwardLines += (po.secondaryOutward || []).length;
  }

  if (APPLY) {
    for (const po of docs) {
      if (!Array.isArray(po.outward)) po.outward = [];
      if (!Array.isArray(po.primaryInward)) po.primaryInward = [];
      if (!Array.isArray(po.primaryOutward)) po.primaryOutward = [];
      po.secondaryInward = [];
      po.secondaryOutward = [];
      await po.save();
    }
  }

  return { batches: docs.length, inwardLines, outwardLines };
}

async function clearLedger() {
  const count = await SecondaryDispatchAvailability.countDocuments({});
  if (APPLY && count > 0) {
    await SecondaryDispatchAvailability.deleteMany({});
  }
  return count;
}

async function clearSlotLagwadFields() {
  if (APPLY) {
    const res = await PlantSlot.updateMany(
      {},
      {
        $set: {
          "subtypeSlots.$[].slots.$[].actualPlants": 0,
          "subtypeSlots.$[].slots.$[].expectedMortality": 0,
          "subtypeSlots.$[].slots.$[].actualReadyPlants": 0,
          "subtypeSlots.$[].slots.$[].lagwadRemaining": 0,
        },
      }
    );
    return { matched: res.matchedCount, modified: res.modifiedCount };
  }
  return null;
}

async function main() {
  console.log(
    APPLY
      ? "=== APPLY — clearing lagwad on PROD ==="
      : "=== DRY RUN — lagwad cleanup (no writes) ==="
  );

  await mongoose.connect(uri());

  const slotBefore = await countLagwadOnSlots();
  const po = await clearPlantOutwards();
  const ledgerCount = await clearLedger();
  const slotUpdate = await clearSlotLagwadFields();

  console.log("\n--- PlantOutward (lagwad lines) ---");
  console.log(`Batches with lagwad/outward: ${po.batches}`);
  console.log(`secondaryInward lines: ${po.inwardLines}`);
  console.log(`secondaryOutward lines: ${po.outwardLines}`);

  console.log("\n--- SecondaryDispatchAvailability ---");
  console.log(`Ledger documents: ${ledgerCount}`);

  console.log("\n--- PlantSlot lagwad fields (before) ---");
  console.log(`PlantSlot docs: ${slotBefore.plantSlotDocs}`);
  console.log(`Slot subdocs: ${slotBefore.slots}`);
  console.log(`Slots with lagwad fields > 0: ${slotBefore.withLagwadFields}`);
  console.log(`Sum actualPlants: ${slotBefore.sumActual.toLocaleString()}`);
  console.log(`Sum expectedMortality: ${slotBefore.sumMortality.toLocaleString()}`);
  console.log(`Sum actualReadyPlants: ${slotBefore.sumReady.toLocaleString()}`);
  console.log(`Sum lagwadRemaining: ${slotBefore.sumLagwadRem.toLocaleString()}`);

  if (APPLY) {
    console.log("\n--- Applied ---");
    if (slotUpdate) {
      console.log(
        `PlantSlot updateMany: matched ${slotUpdate.matched}, modified ${slotUpdate.modified}`
      );
    }
    const slotAfter = await countLagwadOnSlots();
    console.log("\n--- PlantSlot lagwad fields (after) ---");
    console.log(`Slots with lagwad fields > 0: ${slotAfter.withLagwadFields}`);
    console.log(`Sum actualPlants: ${slotAfter.sumActual}`);
    console.log(`Sum expectedMortality: ${slotAfter.sumMortality}`);
    console.log(`Sum actualReadyPlants: ${slotAfter.sumReady}`);
    console.log(`Sum lagwadRemaining: ${slotAfter.sumLagwadRem}`);
    console.log("\nDone. Lagwad cleared on PROD.");
  } else {
    console.log("\nRe-run with --apply to delete lagwad data on PROD.");
  }

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

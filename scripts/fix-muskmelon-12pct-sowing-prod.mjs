/**
 * Restamp Muskmelon sowing batches from 10% → 12% mortality/buffer.
 * Cover pool = sowed − round(sowed × 12/100). Leftover excess stays sowed − orders
 * (no second 12% cut). Slot actual/mortality follow splitLagwadQtyForSlot(12).
 *
 *   node scripts/fix-muskmelon-12pct-sowing-prod.mjs
 *   node scripts/fix-muskmelon-12pct-sowing-prod.mjs --apply
 */
import dotenv from "dotenv";
import mongoose from "mongoose";
import path from "path";
import { fileURLToPath } from "url";
import PlantSlot from "../models/slots.model.js";
import { excessFieldsForBatch } from "../utility/sowingBatchExcessStamp.js";
import { pushBatchChangeLog } from "../utility/sowingBatchChangeLog.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "../.env") });

const APPLY = process.argv.includes("--apply");
const PLANT_ID = "68fdf6d45832d541b274ad09";
const PCT = 12;
const fmt = (n) => Number(n || 0).toLocaleString("en-IN");

function orderQty(batch) {
  return (batch.orders || []).reduce(
    (s, o) => s + Math.max(0, Math.floor(Number(o.plantQty) || 0)),
    0
  );
}

function planBatch(batch) {
  const sowed = Math.max(0, Math.floor(Number(batch.plantsSowed) || 0));
  const coverRaw = Math.max(0, Math.floor(Number(batch.orderCoveredPlants) || 0));
  const leftoverOnly = coverRaw < 1 && orderQty(batch) < 1;
  const bufferPlants = Math.round((sowed * PCT) / 100);
  const actual = Math.max(0, sowed - bufferPlants);
  const pool = leftoverOnly ? 0 : actual;
  const cover = leftoverOnly ? 0 : Math.min(coverRaw, pool);
  const reserved = leftoverOnly ? 0 : Math.min(cover, actual);
  const stamp = excessFieldsForBatch(
    {
      plantsSowed: sowed,
      orderCoveredPlants: cover,
      isIrrelevant: false,
      mortalityMovedToExcess: Math.floor(Number(batch.mortalityMovedToExcess) || 0),
    },
    PCT
  );
  return {
    requestNumber: batch.requestNumber,
    leftoverOnly,
    sowed,
    coverFrom: coverRaw,
    coverTo: cover,
    pool,
    stamp,
    actual,
    mort: bufferPlants,
    reserved,
    avail: leftoverOnly ? 0 : Math.max(0, actual - reserved),
    shownFrom: Math.floor(Number(batch.shownExcess) || 0),
    bufFrom: Math.floor(Number(batch.bufferPlants) || 0),
    pctFrom: Number(batch.sowingBufferPct) || 0,
  };
}

async function main() {
  console.log(APPLY ? "=== APPLY muskmelon 12% restamp ===" : "=== DRY RUN ===");
  await mongoose.connect(process.env.PROD_MONGO_URL);
  const docs = await PlantSlot.find({ plantId: PLANT_ID });
  const plans = [];

  for (const doc of docs) {
    for (const st of doc.subtypeSlots || []) {
      for (const sl of st.slots || []) {
        const batches = (sl.sowingBatches || []).filter((b) => !b.isIrrelevant);
        if (!batches.length) continue;
        const batchPlans = batches.map((b) => planBatch(b));
        const nextActual = batchPlans.reduce((s, p) => s + p.actual, 0);
        const nextMort = batchPlans.reduce((s, p) => s + p.mort, 0);
        const nextReserved = batchPlans.reduce((s, p) => s + p.reserved, 0);
        const nextAvail = batchPlans.reduce((s, p) => s + p.avail, 0);
        const slotFrom = {
          actual: Math.floor(Number(sl.actualPlants) || 0),
          mort: Math.floor(Number(sl.expectedMortality) || 0),
          reserved: Math.floor(Number(sl.orderReservedPlants) || 0),
          avail: Math.floor(Number(sl.availablePlants) || 0),
          sowed: Math.floor(Number(sl.plantsSowed) || 0),
        };
        const changed = batchPlans.some(
          (p) =>
            p.pctFrom !== PCT ||
            p.coverFrom !== p.coverTo ||
            p.shownFrom !== p.stamp.shownExcess ||
            p.bufFrom !== p.stamp.bufferPlants
        );
        if (!changed && slotFrom.actual === nextActual && slotFrom.mort === nextMort) {
          continue;
        }
        plans.push({
          doc,
          subtypeId: st.subtypeId,
          slotId: sl._id,
          startDay: sl.startDay,
          slotFrom,
          slotTo: {
            actual: nextActual,
            mort: nextMort,
            reserved: nextReserved,
            avail: nextAvail,
          },
          batchPlans,
        });
      }
    }
  }

  console.log(`Slots to restamp: ${plans.length}`);
  for (const p of plans) {
    console.log(
      `\n  ${p.startDay} sowed ${fmt(p.slotFrom.sowed)} · actual ${fmt(p.slotFrom.actual)}→${fmt(p.slotTo.actual)} · mort ${fmt(p.slotFrom.mort)}→${fmt(p.slotTo.mort)} · reserved ${fmt(p.slotFrom.reserved)}→${fmt(p.slotTo.reserved)} · avail ${fmt(p.slotFrom.avail)}→${fmt(p.slotTo.avail)}`
    );
    for (const b of p.batchPlans) {
      console.log(
        `    ${b.requestNumber} cover ${fmt(b.coverFrom)}→${fmt(b.coverTo)} (pool ${fmt(b.pool)}) · excess ${fmt(b.shownFrom)}→${fmt(b.stamp.shownExcess)} · buf ${fmt(b.bufFrom)}→${fmt(b.stamp.bufferPlants)} · leftoverOnly ${b.leftoverOnly}`
      );
    }
  }

  if (!APPLY) {
    console.log("\nRe-run with --apply to write PROD.");
    await mongoose.disconnect();
    return;
  }

  for (const p of plans) {
    const doc = await PlantSlot.findById(p.doc._id);
    const st = (doc.subtypeSlots || []).find(
      (s) => String(s.subtypeId) === String(p.subtypeId)
    );
    const sl = (st?.slots || []).find((s) => String(s._id) === String(p.slotId));
    if (!sl) continue;
    for (const b of sl.sowingBatches || []) {
      if (b.isIrrelevant) continue;
      const plan = p.batchPlans.find(
        (x) => String(x.requestNumber) === String(b.requestNumber)
      );
      if (!plan) continue;
      const coverBefore = Math.floor(Number(b.orderCoveredPlants) || 0);
      const excessBefore = Math.floor(Number(b.shownExcess) || 0);
      b.sowingBufferPct = PCT;
      b.mortalityPct = PCT;
      b.bufferPlants = plan.stamp.bufferPlants;
      b.shownExcess = plan.stamp.shownExcess;
      b.orderCoveredPlants = plan.coverTo;
      let drop = coverBefore - plan.coverTo;
      if (drop > 0 && Array.isArray(b.orders)) {
        for (let i = b.orders.length - 1; i >= 0 && drop > 0; i -= 1) {
          const q = Math.max(0, Math.floor(Number(b.orders[i].plantQty) || 0));
          const cut = Math.min(q, drop);
          b.orders[i].plantQty = q - cut;
          drop -= cut;
        }
      }
      b.actualPlantsApplied = plan.actual;
      b.expectedMortalityApplied = plan.mort;
      b.orderReservedPlantsApplied = plan.reserved;
      b.availablePlantsApplied = plan.avail;
      pushBatchChangeLog(b, {
        kind: "BUFFER_PCT",
        plants: plan.sowed,
        coverBefore,
        coverAfter: plan.coverTo,
        excessBefore,
        excessAfter: plan.stamp.shownExcess,
        reason: `Muskmelon mortality/buffer 10% → 12%. Cover from actual (pool ${plan.pool}).`,
      });
    }
    sl.actualPlants = p.slotTo.actual;
    sl.expectedMortality = p.slotTo.mort;
    sl.orderReservedPlants = p.slotTo.reserved;
    sl.availablePlants = p.slotTo.avail;
    sl.availablePlantsMaterialized = true;
    await doc.save();
  }

  console.log(`Wrote ${plans.length} slots`);
  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

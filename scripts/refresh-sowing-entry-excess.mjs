/**
 * Refresh sowingentries cover and excess from the live plant-slot batch.
 * Excess = sowed − CMS mortality − cover. Does not rewrite slot batches.
 *
 *   node scripts/refresh-sowing-entry-excess.mjs
 *   node scripts/refresh-sowing-entry-excess.mjs --apply
 */
import dotenv from "dotenv";
import mongoose from "mongoose";
import path from "path";
import { fileURLToPath } from "url";
import PlantSlot from "../models/slots.model.js";
import SowingEntry from "../models/sowingEntry.model.js";
import { excessFieldsForBatch } from "../utility/sowingBatchExcessStamp.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "../.env") });

const APPLY = process.argv.includes("--apply");
const intQty = (value) => Math.max(0, Math.floor(Number(value) || 0));

function patchFor(batch) {
  const fields = excessFieldsForBatch(batch, batch?.sowingBufferPct || 0);
  return {
    plantsSowed: intQty(batch.plantsSowed),
    orderCoveredPlants: intQty(batch.orderCoveredPlants),
    sowingBufferPct: fields.sowingBufferPct,
    bufferPlants: fields.bufferPlants,
    excessPlants: batch.isIrrelevant ? 0 : fields.shownExcess,
    mortalityMovedToExcess: intQty(batch.mortalityMovedToExcess),
    excessMovedToMortality: intQty(batch.excessMovedToMortality),
    noMortalityReserve: Boolean(batch.noMortalityReserve),
    isIrrelevant: Boolean(batch.isIrrelevant),
    linkedOrderIds: batch.linkedOrderIds || [],
  };
}

function changed(entry, next) {
  const keys = [
    "plantsSowed",
    "orderCoveredPlants",
    "sowingBufferPct",
    "bufferPlants",
    "excessPlants",
    "mortalityMovedToExcess",
    "excessMovedToMortality",
  ];
  if (keys.some((key) => intQty(entry[key]) !== intQty(next[key]))) return true;
  if (Boolean(entry.noMortalityReserve) !== next.noMortalityReserve) return true;
  if (Boolean(entry.isIrrelevant) !== next.isIrrelevant) return true;
  const before = (entry.linkedOrderIds || []).map(String).sort().join(",");
  const after = next.linkedOrderIds.map(String).sort().join(",");
  return before !== after;
}

async function main() {
  const uri = process.env.PROD_MONGO_URL || process.env.MONGO_URL;
  if (!uri) throw new Error("Missing MONGO_URL / PROD_MONGO_URL");
  console.log(APPLY ? "APPLY refresh sowing entry excess\n" : "DRY-RUN refresh sowing entry excess\n");
  await mongoose.connect(uri);

  const entries = await SowingEntry.find().select(
    "requestNumber sourceBatchId plantsSowed orderCoveredPlants sowingBufferPct bufferPlants excessPlants mortalityMovedToExcess excessMovedToMortality noMortalityReserve isIrrelevant linkedOrderIds"
  ).lean();
  const byBatch = new Map(entries.map((row) => [String(row.sourceBatchId), row]));
  const slots = await PlantSlot.find({ "subtypeSlots.slots.sowingBatches.0": { $exists: true } })
    .select("subtypeSlots.slots.sowingBatches")
    .lean();

  const ops = [];
  const sample = [];
  for (const doc of slots) {
    for (const subtype of doc.subtypeSlots || []) {
      for (const slot of subtype.slots || []) {
        for (const batch of slot.sowingBatches || []) {
          const entry = byBatch.get(String(batch._id));
          if (!entry) continue;
          const next = patchFor(batch);
          if (!changed(entry, next)) continue;
          sample.push({
            id: entry.requestNumber,
            excess: `${intQty(entry.excessPlants)} -> ${next.excessPlants}`,
            cover: `${intQty(entry.orderCoveredPlants)} -> ${next.orderCoveredPlants}`,
          });
          ops.push({
            updateOne: {
              filter: { _id: entry._id },
              update: { $set: next },
            },
          });
        }
      }
    }
  }

  console.log(JSON.stringify({ updates: ops.length, sample: sample.slice(0, 15) }));
  if (APPLY && ops.length) {
    const result = await SowingEntry.bulkWrite(ops, { ordered: false });
    console.log(JSON.stringify({ matched: result.matchedCount, modified: result.modifiedCount }));
  }
  await mongoose.disconnect();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

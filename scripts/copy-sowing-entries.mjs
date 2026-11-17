/**
 * Copy each nested sowing batch into its own sowingentries document.
 * Does not delete or rewrite plant-slot batches.
 *
 *   node scripts/copy-sowing-entries.mjs
 *   node scripts/copy-sowing-entries.mjs --apply
 */
import dotenv from "dotenv";
import mongoose from "mongoose";
import path from "path";
import { fileURLToPath } from "url";
import PlantCms from "../models/plantCms.model.js";
import PlantSlot from "../models/slots.model.js";
import SowingEntry from "../models/sowingEntry.model.js";
import { excessFieldsForBatch } from "../utility/sowingBatchExcessStamp.js";
import { sowDayFrom } from "../modules/sowingEntries/mapSowingEntry.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "../.env") });

const APPLY = process.argv.includes("--apply");

function intQty(value) {
  return Math.max(0, Math.floor(Number(value) || 0));
}

function cmsPctOf(plant) {
  if (plant?.sowingMortality != null && Number.isFinite(Number(plant.sowingMortality))) {
    return Math.max(0, Number(plant.sowingMortality));
  }
  if (plant?.sowingBuffer != null && Number.isFinite(Number(plant.sowingBuffer))) {
    return Math.max(0, Number(plant.sowingBuffer));
  }
  return 0;
}

function namesFor(plant, subtypeId) {
  const subtype = (plant?.subtypes || []).find((row) => String(row._id) === String(subtypeId));
  return {
    plantName: plant?.name || "",
    subtypeName: subtype?.name || "",
  };
}

function entryFromBatch(doc, subtype, batch, names, cmsPct = 0) {
  // Blank batch % falls back to plant CMS. An explicit 0 stays 0. Ready plants stay 0.
  const rawPct = batch?.sowingBufferPct;
  const usePct = batch?.noMortalityReserve ? 0 : rawPct == null ? cmsPct : Number(rawPct) || 0;
  const fields = excessFieldsForBatch(batch, usePct);
  const sowed = intQty(batch.plantsSowed);
  return {
    sourceBatchId: batch._id,
    sowingRequestId: batch.sowingRequestId || null,
    requestNumber: batch.requestNumber || "",
    plantId: doc.plantId,
    plantName: names.plantName,
    subtypeId: subtype.subtypeId,
    subtypeName: names.subtypeName,
    year: doc.year,
    sowingDate: batch.sowingDate || "",
    sowDay: sowDayFrom(batch.sowingDate),
    plantReadyDate: batch.plantReadyDate || "",
    plantsSowed: sowed,
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

async function main() {
  const uri = process.env.PROD_MONGO_URL || process.env.MONGO_URL;
  if (!uri) throw new Error("Missing MONGO_URL / PROD_MONGO_URL");
  console.log(APPLY ? "APPLY copy sowing entries\n" : "DRY-RUN copy sowing entries\n");
  await mongoose.connect(uri);

  const plants = await PlantCms.find()
    .select("name subtypes._id subtypes.name sowingMortality sowingBuffer")
    .lean();
  const plantById = new Map(plants.map((plant) => [String(plant._id), plant]));
  const cursor = PlantSlot.find({ "subtypeSlots.slots.sowingBatches.0": { $exists: true } })
    .select("plantId year subtypeSlots.subtypeId subtypeSlots.slots.sowingBatches")
    .lean()
    .cursor();

  let batches = 0;
  let written = 0;
  const samples = [];
  for await (const doc of cursor) {
    const plant = plantById.get(String(doc.plantId));
    for (const subtype of doc.subtypeSlots || []) {
      const names = namesFor(plant, subtype.subtypeId);
      for (const slot of subtype.slots || []) {
        for (const batch of slot.sowingBatches || []) {
          if (!batch?._id) continue;
          if (!intQty(batch.plantsSowed) && !batch.requestNumber) continue;
          batches += 1;
          const entry = entryFromBatch(doc, subtype, batch, names, cmsPctOf(plant));
          if (samples.length < 3 || entry.requestNumber === "SR202610260017") samples.push(entry);
          if (!APPLY) continue;
          await SowingEntry.updateOne(
            { sourceBatchId: entry.sourceBatchId },
            { $set: entry },
            { upsert: true }
          );
          written += 1;
        }
      }
    }
  }

  console.log(JSON.stringify({
    apply: APPLY,
    batches,
    written,
    samples: samples.map((row) => ({
      req: row.requestNumber,
      plant: row.plantName,
      variety: row.subtypeName,
      sowed: row.plantsSowed,
      cover: row.orderCoveredPlants,
      buffer: row.bufferPlants,
      excess: row.excessPlants,
    })),
  }, null, 2));
  await mongoose.disconnect();
  if (!APPLY) console.log("\nRe-run with --apply to write sowingentries");
}

main().catch((err) => {
  console.error(err?.message || err);
  process.exit(1);
});

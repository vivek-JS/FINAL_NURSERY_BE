/**
 * Watermelon (all varieties): sowing batches ready before 14 Oct 2026 become irrelevant.
 * Their excess leaves bookable stock. Dry-run unless --apply is passed.
 *   node scripts/mark-watermelon-irrelevant-before-14oct.mjs
 *   node scripts/mark-watermelon-irrelevant-before-14oct.mjs --apply
 */
import dotenv from "dotenv";
import mongoose from "mongoose";
import path from "path";
import { fileURLToPath } from "url";
import PlantCms from "../models/plantCms.model.js";
import PlantSlot from "../models/slots.model.js";
import {
  batchSaleableStock,
  isWatermelonPlantName,
  readyBeforeYmd,
  setSowBatchIrrelevant,
} from "../services/sowBatchIrrelevant.service.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "..", ".env") });

const APPLY = process.argv.includes("--apply");
const n = (v) => Math.max(0, Math.floor(Number(v) || 0));

function collect(doc, nameById) {
  const hits = [];
  const plantName = nameById.get(String(doc.plantId)) || "";
  if (!isWatermelonPlantName(plantName)) return hits;
  for (const st of doc.subtypeSlots || []) {
    for (const slot of st.slots || []) {
      for (const batch of slot.sowingBatches || []) {
        if (batch.isIrrelevant || !readyBeforeYmd(batch.plantReadyDate)) continue;
        hits.push({
          slotId: String(slot._id),
          batchId: String(batch._id),
          plantName,
          requestNumber: batch.requestNumber || "",
          plantReadyDate: batch.plantReadyDate || "",
          plantsSowed: n(batch.plantsSowed),
          excessPlants: n(batch.excessPlants),
          saleable: batchSaleableStock(batch),
        });
      }
    }
  }
  return hits;
}

async function main() {
  const uri = process.env.PROD_MONGO_URL || process.env.MONGO_URL;
  if (!uri) throw new Error("Missing MONGO_URL / PROD_MONGO_URL");
  await mongoose.connect(uri);

  const plants = await PlantCms.find({ name: { $regex: /water|tarbuj/i } }).select("_id name").lean();
  const nameById = new Map(plants.map((p) => [String(p._id), p.name]));
  const hits = [];
  const cursor = PlantSlot.find({
    plantId: { $in: plants.map((p) => p._id) },
    "subtypeSlots.slots.sowingBatches.0": { $exists: true },
  })
    .select("plantId subtypeSlots.slots")
    .cursor();

  for await (const doc of cursor) hits.push(...collect(doc, nameById));

  const totals = hits.reduce(
    (s, h) => {
      s.batches += 1;
      s.plantsSowed += h.plantsSowed;
      s.excessPlants += h.excessPlants;
      s.saleable += h.saleable;
      return s;
    },
    { batches: 0, plantsSowed: 0, excessPlants: 0, saleable: 0 }
  );
  console.log(JSON.stringify({ apply: APPLY, plants: plants.map((p) => p.name), totals, hits }, null, 2));

  if (!APPLY) {
    console.log("Dry run only. Re-run with --apply to mark these batches irrelevant.");
    return;
  }

  let marked = 0;
  const failed = [];
  for (const hit of hits) {
    try {
      await setSowBatchIrrelevant({
        slotId: hit.slotId,
        batchId: hit.batchId,
        isIrrelevant: true,
      });
      marked += 1;
    } catch (err) {
      failed.push({ ...hit, error: err?.message || String(err) });
    }
  }
  console.log(JSON.stringify({ marked, failed }, null, 2));
}

try {
  await main();
} finally {
  await mongoose.disconnect();
}

/**
 * Write sowingBufferPct, bufferPlants, and shownExcess onto every sowing batch.
 *   node scripts/stamp-sowing-excess.mjs
 */
import dotenv from "dotenv";
import mongoose from "mongoose";
import path from "path";
import { fileURLToPath } from "url";
import PlantCms from "../models/plantCms.model.js";
import PlantSlot from "../models/slots.model.js";
import { excessFieldsForBatch } from "../utility/sowingBatchExcessStamp.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "../.env") });

async function main() {
  const uri = process.env.PROD_MONGO_URL || process.env.MONGO_URL;
  if (!uri) throw new Error("Missing MONGO_URL / PROD_MONGO_URL");
  await mongoose.connect(uri);
  const plants = await PlantCms.find().select("sowingBuffer").lean();
  const pctByPlant = new Map(
    plants.map((plant) => [String(plant._id), Math.max(0, Number(plant.sowingBuffer) || 0)])
  );
  const cursor = PlantSlot.find({ "subtypeSlots.slots.sowingBatches.0": { $exists: true } })
    .select("plantId subtypeSlots.slots.sowingBatches")
    .lean()
    .cursor();
  let docs = 0;
  let batches = 0;
  for await (const doc of cursor) {
    const pct = pctByPlant.get(String(doc.plantId)) || 0;
    const $set = {};
    (doc.subtypeSlots || []).forEach((subtype, subtypeIndex) => {
      (subtype.slots || []).forEach((slot, slotIndex) => {
        (slot.sowingBatches || []).forEach((batch, batchIndex) => {
          const fields = excessFieldsForBatch(batch, pct);
          const base = `subtypeSlots.${subtypeIndex}.slots.${slotIndex}.sowingBatches.${batchIndex}`;
          $set[`${base}.sowingBufferPct`] = fields.sowingBufferPct;
          $set[`${base}.bufferPlants`] = fields.bufferPlants;
          $set[`${base}.shownExcess`] = fields.shownExcess;
          batches += 1;
        });
      });
    });
    if (Object.keys($set).length) {
      await PlantSlot.collection.updateOne({ _id: doc._id }, { $set });
      docs += 1;
    }
  }
  console.log(JSON.stringify({ docs, batches }));
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err?.message || err);
  process.exit(1);
});

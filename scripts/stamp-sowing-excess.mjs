/**
 * Restamp every sowing batch: bufferPlants, shownExcess, excessPlants.
 * Excess = sowed − CMS mortality − order cover (+ mortalityMovedToExcess).
 *
 *   node scripts/stamp-sowing-excess.mjs           # dry-run
 *   node scripts/stamp-sowing-excess.mjs --apply   # write PROD
 */
import dotenv from "dotenv";
import mongoose from "mongoose";
import path from "path";
import { fileURLToPath } from "url";
import PlantCms from "../models/plantCms.model.js";
import PlantSlot from "../models/slots.model.js";
import { excessFieldsForBatch } from "../utility/sowingBatchExcessStamp.js";
import { plantMortalityPct } from "../utility/plantSowingBuffer.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "../.env") });

const APPLY = process.argv.includes("--apply");
const SAMPLE_REQS = new Set(["SR202610130003"]);

async function main() {
  const uri = process.env.PROD_MONGO_URL || process.env.MONGO_URL;
  if (!uri) throw new Error("Missing MONGO_URL / PROD_MONGO_URL");
  console.log(APPLY ? "APPLY stamp sowing excess — PROD\n" : "DRY-RUN stamp sowing excess — PROD\n");

  await mongoose.connect(uri);
  const plants = await PlantCms.find().select("sowingMortality sowingBuffer").lean();
  const pctByPlant = new Map(plants.map((plant) => [String(plant._id), plantMortalityPct(plant)]));

  const cursor = PlantSlot.find({ "subtypeSlots.slots.sowingBatches.0": { $exists: true } })
    .select("plantId subtypeSlots")
    .lean()
    .cursor();

  let docs = 0;
  let batches = 0;
  let changed = 0;
  let slotExcessSynced = 0;
  const samples = [];

  for await (const doc of cursor) {
    const pct = pctByPlant.get(String(doc.plantId)) || 0;
    const $set = {};
    (doc.subtypeSlots || []).forEach((subtype, subtypeIndex) => {
      (subtype.slots || []).forEach((slot, slotIndex) => {
        let slotBookable = 0;
        (slot.sowingBatches || []).forEach((batch, batchIndex) => {
          const batchPct = Number(batch?.sowingBufferPct);
          const usePct =
            !batch?.noMortalityReserve && Number.isFinite(batchPct) && batchPct > 0
              ? batchPct
              : pct;
          const fields = excessFieldsForBatch(batch, usePct);
          const base = `subtypeSlots.${subtypeIndex}.slots.${slotIndex}.sowingBatches.${batchIndex}`;
          const oldShown =
            batch.shownExcess != null
              ? Number(batch.shownExcess)
              : batch.excessPlants != null
                ? Number(batch.excessPlants)
                : null;
          const newShown = fields.shownExcess;

          $set[`${base}.sowingBufferPct`] = fields.sowingBufferPct;
          $set[`${base}.bufferPlants`] = fields.bufferPlants;
          $set[`${base}.shownExcess`] = newShown;
          $set[`${base}.excessPlants`] = newShown;
          slotBookable += newShown;
          batches += 1;

          const oldExcess = batch.excessPlants != null ? Number(batch.excessPlants) : null;
          if (oldShown !== newShown || oldExcess !== newShown) changed += 1;
          if (SAMPLE_REQS.has(batch.requestNumber) || samples.length < 8) {
            samples.push({
              req: batch.requestNumber || "—",
              sowed: batch.plantsSowed,
              cover: batch.orderCoveredPlants,
              buffer: fields.bufferPlants,
              oldShown,
              newShown,
              moved: batch.mortalityMovedToExcess || 0,
              irrelevant: Boolean(batch.isIrrelevant),
            });
          }
        });

        const prevSlotExcess = Number(slot?.excessiveSowing?.plants);
        if (
          Array.isArray(slot.sowingBatches) &&
          slot.sowingBatches.length > 0 &&
          (!Number.isFinite(prevSlotExcess) || prevSlotExcess !== slotBookable)
        ) {
          $set[`subtypeSlots.${subtypeIndex}.slots.${slotIndex}.excessiveSowing.plants`] =
            slotBookable;
          slotExcessSynced += 1;
        }
      });
    });

    if (Object.keys($set).length) {
      docs += 1;
      if (APPLY) {
        await PlantSlot.collection.updateOne({ _id: doc._id }, { $set });
      }
    }
  }

  console.log(
    JSON.stringify(
      {
        apply: APPLY,
        docs,
        batches,
        batchesChanged: changed,
        slotsExcessSynced: slotExcessSynced,
        samples,
      },
      null,
      2
    )
  );

  const simbha = samples.find((s) => s.req === "SR202610130003");
  if (simbha) {
    console.log(
      `\nSR202610130003 → Excess ${simbha.newShown} (was ${simbha.oldShown}); expect 2765`
    );
  }

  await mongoose.disconnect();
  if (!APPLY) console.log("\nRe-run with --apply to write PROD");
}

main().catch((err) => {
  console.error(err?.message || err);
  process.exit(1);
});

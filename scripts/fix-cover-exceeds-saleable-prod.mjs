/**
 * Cap orderCoveredPlants at saleable pool (sowed − CMS mortality) so Excess math
 * is never negative before clamp. Also repairs negative slot.actualPlants.
 *
 *   node scripts/fix-cover-exceeds-saleable-prod.mjs           # dry-run
 *   node scripts/fix-cover-exceeds-saleable-prod.mjs --apply   # write PROD
 */
import dotenv from "dotenv";
import mongoose from "mongoose";
import path from "path";
import { fileURLToPath } from "url";
import PlantCms from "../models/plantCms.model.js";
import PlantSlot from "../models/slots.model.js";
import { excessFieldsForBatch } from "../utility/sowingBatchExcessStamp.js";
import { splitLagwadQtyForSlot } from "../utility/lagwadSlotPlantsSplit.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "../.env") });

const APPLY = process.argv.includes("--apply");

async function main() {
  const uri = process.env.PROD_MONGO_URL || process.env.MONGO_URL;
  if (!uri) throw new Error("Missing MONGO_URL / PROD_MONGO_URL");
  console.log(
    APPLY ? "APPLY fix cover>saleable — PROD\n" : "DRY-RUN fix cover>saleable — PROD\n"
  );

  await mongoose.connect(uri);
  const plants = await PlantCms.find().select("sowingBuffer").lean();
  const pctByPlant = new Map(
    plants.map((p) => [String(p._id), Math.max(0, Number(p.sowingBuffer) || 0)])
  );

  const cursor = PlantSlot.find({ "subtypeSlots.slots.sowingBatches.0": { $exists: true } })
    .select("plantId subtypeSlots")
    .lean()
    .cursor();

  let docs = 0;
  let batchesFixed = 0;
  let slotsActualFixed = 0;
  let coverReducedTotal = 0;
  const samples = [];

  for await (const doc of cursor) {
    const plantPct = pctByPlant.get(String(doc.plantId)) || 0;
    const $set = {};
    let docChanged = false;

    (doc.subtypeSlots || []).forEach((subtype, subtypeIndex) => {
      (subtype.slots || []).forEach((slot, slotIndex) => {
        let slotReservedDelta = 0;
        let slotBookable = 0;
        let batchActualSum = 0;
        let batchMortSum = 0;

        (slot.sowingBatches || []).forEach((batch, batchIndex) => {
          const pct = batch?.sowingBufferPct ?? plantPct;
          const fields = excessFieldsForBatch(batch, pct);
          const sowed = Math.max(0, Math.floor(Number(batch.plantsSowed) || 0));
          const cover = Math.max(0, Math.floor(Number(batch.orderCoveredPlants) || 0));
          const buffer = fields.bufferPlants;
          const saleable = Math.max(0, sowed - buffer);
          const base = `subtypeSlots.${subtypeIndex}.slots.${slotIndex}.sowingBatches.${batchIndex}`;

          let nextCover = cover;
          let nextReservedApplied =
            batch.orderReservedPlantsApplied == null
              ? null
              : Math.max(0, Math.floor(Number(batch.orderReservedPlantsApplied) || 0));

          if (!batch.isIrrelevant && cover > saleable) {
            const reduceBy = cover - saleable;
            nextCover = saleable;
            coverReducedTotal += reduceBy;
            batchesFixed += 1;
            slotReservedDelta += reduceBy;
            if (nextReservedApplied != null && nextReservedApplied > saleable) {
              nextReservedApplied = saleable;
            }
            if (samples.length < 25 || batch.requestNumber === "SR202610160011") {
              samples.push({
                req: batch.requestNumber || "—",
                sowed,
                coverBefore: cover,
                coverAfter: nextCover,
                buffer,
                saleable,
                reduceBy,
              });
            }
          }

          const nextBatch = {
            ...batch,
            orderCoveredPlants: nextCover,
            ...(nextReservedApplied != null
              ? { orderReservedPlantsApplied: nextReservedApplied }
              : {}),
            sowingBufferPct: fields.sowingBufferPct,
            bufferPlants: buffer,
          };
          const stamped = excessFieldsForBatch(nextBatch, pct);

          $set[`${base}.orderCoveredPlants`] = nextCover;
          if (nextReservedApplied != null) {
            $set[`${base}.orderReservedPlantsApplied`] = nextReservedApplied;
          }
          $set[`${base}.sowingBufferPct`] = stamped.sowingBufferPct;
          $set[`${base}.bufferPlants`] = stamped.bufferPlants;
          $set[`${base}.shownExcess`] = stamped.shownExcess;
          $set[`${base}.excessPlants`] = stamped.shownExcess;
          slotBookable += stamped.shownExcess;

          const actualApplied = Number(batch.actualPlantsApplied);
          const mortApplied = Number(batch.expectedMortalityApplied);
          if (Number.isFinite(actualApplied) && actualApplied >= 0) {
            batchActualSum += actualApplied;
          } else {
            const split = splitLagwadQtyForSlot(sowed, 10);
            batchActualSum += split.actualPlants;
            batchMortSum += split.expectedMortality;
          }
          if (Number.isFinite(mortApplied) && mortApplied >= 0) {
            batchMortSum += mortApplied;
          }

          if (nextCover !== cover) docChanged = true;
        });

        if (slotReservedDelta > 0) {
          const prevReserved = Math.max(0, Math.floor(Number(slot.orderReservedPlants) || 0));
          $set[`subtypeSlots.${subtypeIndex}.slots.${slotIndex}.orderReservedPlants`] = Math.max(
            0,
            prevReserved - slotReservedDelta
          );
          docChanged = true;
        }

        $set[`subtypeSlots.${subtypeIndex}.slots.${slotIndex}.excessiveSowing.plants`] =
          slotBookable;

        const prevActual = Number(slot.actualPlants);
        if (
          (slot.sowingBatches || []).length > 0 &&
          (prevActual < 0 || !Number.isFinite(prevActual))
        ) {
          $set[`subtypeSlots.${subtypeIndex}.slots.${slotIndex}.actualPlants`] = batchActualSum;
          if (batchMortSum > 0) {
            $set[`subtypeSlots.${subtypeIndex}.slots.${slotIndex}.expectedMortality`] =
              batchMortSum;
          }
          slotsActualFixed += 1;
          docChanged = true;
          samples.push({
            slotFix: true,
            startDay: slot.startDay,
            prevActual,
            nextActual: batchActualSum,
          });
        }
      });
    });

    if (docChanged && Object.keys($set).length) {
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
        batchesFixed,
        coverReducedTotal,
        slotsActualFixed,
        samples,
      },
      null,
      2
    )
  );

  await mongoose.disconnect();
  if (!APPLY) console.log("\nRe-run with --apply to write PROD");
}

main().catch((err) => {
  console.error(err?.message || err);
  process.exit(1);
});

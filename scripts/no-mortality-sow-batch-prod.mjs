/**
 * Count a sowing batch's full sowed plants as actual/sellable (drop the 10% mortality reserve)
 * on PROD. Sets batch.noMortalityReserve so sowBatchStock / slotSowStock hold nothing back.
 *
 *   node scripts/no-mortality-sow-batch-prod.mjs           # dry-run
 *   node scripts/no-mortality-sow-batch-prod.mjs --apply   # write PROD
 */
import mongoose from "mongoose";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import SowingRequest from "../models/sowingRequest.model.js";
import PlantSlot from "../models/slots.model.js";
import { findSowBatchForRequest, pushEvent } from "../controllers/sowingCompleteHelpers.js";
import { sowBatchStock } from "../utility/lagwadSlotPlantsSplit.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "..", ".env") });

const APPLY = process.argv.includes("--apply");
const REQUEST_NUMBERS = ["SR202610120001"];
const ADMIN_ID = new mongoose.Types.ObjectId("69c74937ac73e9c36b673925");

async function slotRow(slotId) {
  const [row] = await PlantSlot.aggregate([
    { $match: { "subtypeSlots.slots._id": slotId } },
    { $unwind: "$subtypeSlots" },
    { $unwind: "$subtypeSlots.slots" },
    { $match: { "subtypeSlots.slots._id": slotId } },
    { $replaceRoot: { newRoot: "$subtypeSlots.slots" } },
  ]);
  return row;
}

function fmtSlot(s) {
  return `sowed ${s.plantsSowed} · actual ${s.actualPlants} · mort ${s.expectedMortality} · avail ${s.availablePlants} · excess ${s.excessiveSowing?.plants ?? 0} · reserved ${s.orderReservedPlants ?? 0}`;
}

async function main() {
  console.log(APPLY ? "APPLY no-mortality — PROD\n" : "DRY-RUN no-mortality — PROD\n");
  await mongoose.connect(process.env.PROD_MONGO_URL);

  for (const requestNumber of REQUEST_NUMBERS) {
    console.log("─".repeat(70));
    const request = await SowingRequest.findOne({ requestNumber });
    if (!request) {
      console.log(`${requestNumber}: NOT FOUND`);
      continue;
    }
    const rows = await findSowBatchForRequest(request._id);
    if (rows.length !== 1) {
      console.log(`${requestNumber}: expected 1 slot batch, found ${rows.length} — skip`);
      continue;
    }
    const { slotId, startDay, batch } = rows[0];
    const slot = await slotRow(slotId);
    const mort = Math.max(0, Number(batch.expectedMortalityApplied) || 0);
    const stockNow = sowBatchStock(batch);
    const stockAfter = sowBatchStock({ ...batch, noMortalityReserve: true });

    console.log(`${requestNumber} · ${request.subtypeName} · ${request.sowedQuantity} plants · slot ${startDay}`);
    console.log(`Batch: actual ${batch.actualPlantsApplied} · mort ${mort} · avail ${batch.availablePlantsApplied} · covered ${batch.orderCoveredPlants ?? 0} · flag ${Boolean(batch.noMortalityReserve)}`);
    console.log(`Sellable now ${stockNow.free} (reserve ${stockNow.reserve}) → after ${stockAfter.free} (reserve ${stockAfter.reserve})`);
    console.log(`Slot now:   ${fmtSlot(slot)}`);

    if (batch.noMortalityReserve && mort === 0) {
      console.log("Already no-mortality — skip");
      continue;
    }
    if (!APPLY) continue;

    const inc = {
      "subtypeSlots.$[st].slots.$[sl].actualPlants": mort,
      "subtypeSlots.$[st].slots.$[sl].expectedMortality": -mort,
      "subtypeSlots.$[st].slots.$[sl].availablePlants": mort,
      "subtypeSlots.$[st].slots.$[sl].sowingBatches.$[b].actualPlantsApplied": mort,
      "subtypeSlots.$[st].slots.$[sl].sowingBatches.$[b].availablePlantsApplied": mort,
    };
    if (request.isExcessiveSowing) {
      inc["subtypeSlots.$[st].slots.$[sl].excessiveSowing.plants"] = mort;
    }
    await PlantSlot.updateOne(
      { "subtypeSlots.slots._id": slotId },
      {
        $inc: inc,
        $set: {
          "subtypeSlots.$[st].slots.$[sl].sowingBatches.$[b].expectedMortalityApplied": 0,
          "subtypeSlots.$[st].slots.$[sl].sowingBatches.$[b].noMortalityReserve": true,
        },
      },
      {
        arrayFilters: [
          { "st.slots._id": slotId },
          { "sl._id": slotId },
          { "b.sowingRequestId": request._id },
        ],
      }
    );

    if (mort > 0) {
      pushEvent(request, {
        type: "NOTE",
        by: ADMIN_ID,
        quantity: mort,
        unit: "plants",
        message: `No mortality reserve: all ${request.sowedQuantity} plants counted (+${mort} actual)`,
        meta: { noMortalityReserve: true, slotId: String(slotId), mortalityReleased: mort },
      });
      await request.save();
    }

    const after = await slotRow(slotId);
    console.log(`Slot after: ${fmtSlot(after)}`);
    console.log("APPLIED");
  }

  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

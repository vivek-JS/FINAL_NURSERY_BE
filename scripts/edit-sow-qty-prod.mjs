/**
 * Add/remove plants on a completed sowing request (PROD) — re-applies the slot batch
 * via editSowEntryOnSlots and keeps request + completion-event quantities in sync.
 *
 *   TZ=UTC node scripts/edit-sow-qty-prod.mjs           # dry-run
 *   TZ=UTC node scripts/edit-sow-qty-prod.mjs --apply   # write PROD
 */
import mongoose from "mongoose";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import SowingRequest from "../models/sowingRequest.model.js";
import PlantSlot from "../models/slots.model.js";
import {
  editSowEntryOnSlots,
  findSowBatchForRequest,
  pushEvent,
} from "../controllers/sowingCompleteHelpers.js";
import { sowQtySlotImpact } from "../utility/lagwadSlotPlantsSplit.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "..", ".env") });

const APPLY = process.argv.includes("--apply");

const EDITS = [{ requestNumber: "SR202609300003", addPlants: 2000, expectFrom: 21546 }];

async function main() {
  if (process.env.TZ !== "UTC") {
    throw new Error("Run with TZ=UTC so sow dates are stored at 12:00Z like the server");
  }
  console.log(APPLY ? "APPLY sow qty edits — PROD\n" : "DRY-RUN sow qty edits — PROD\n");

  await mongoose.connect(process.env.PROD_MONGO_URL);
  const adminId = new mongoose.Types.ObjectId("69c74937ac73e9c36b673925");

  for (const edit of EDITS) {
    console.log("─".repeat(70));
    const request = await SowingRequest.findOne({ requestNumber: edit.requestNumber });
    if (!request) {
      console.log(`${edit.requestNumber}: NOT FOUND`);
      continue;
    }
    const from = Number(request.sowedQuantity) || 0;
    const to = from + edit.addPlants;
    const rows = await findSowBatchForRequest(request._id);
    const isExcess = Boolean(request.isExcessiveSowing) && !(request.linkedOrderIds || []).length;

    console.log(
      `${edit.requestNumber} · ${request.subtypeName} · ${isExcess ? "excess" : "order"} · plants ${from} → ${to}`
    );
    for (const r of rows) {
      console.log(
        `Slot ${r.startDay} – ${r.endDay} (${r.slotId}) · batch ${r.batch.plantsSowed} · actual ${r.batch.actualPlantsApplied} · mort ${r.batch.expectedMortalityApplied} · avail ${r.batch.availablePlantsApplied}`
      );
    }
    const after = sowQtySlotImpact(to, {
      isExcess,
      excessPlants: isExcess ? to : 0,
      orderCoveredPlants: isExcess ? 0 : to,
    });
    console.log(
      `After: actual ${after.actualPlants} · mort ${after.expectedMortality} · avail ${after.availablePlants} · reserved ${after.orderReservedPlants}`
    );

    if (from !== edit.expectFrom) {
      console.log(`Current plants ${from} ≠ expected ${edit.expectFrom} — skip (already applied?)`);
      continue;
    }
    if (rows.length !== 1) {
      console.log(`Expected exactly 1 slot batch, found ${rows.length} — skip`);
      continue;
    }
    if (!APPLY) continue;

    const result = await editSowEntryOnSlots(request, {
      by: adminId,
      plantsSowed: to,
      reason: "EDIT_PLANTS_SOWED",
    });

    if (isExcess) {
      const slotId = new mongoose.Types.ObjectId(result.toSlotId);
      await PlantSlot.updateOne(
        { "subtypeSlots.slots._id": slotId },
        { $set: { "subtypeSlots.$[st].slots.$[sl].sowingBatches.$[b].excessPlants": to } },
        {
          arrayFilters: [
            { "st.slots._id": slotId },
            { "sl._id": slotId },
            { "b.sowingRequestId": request._id },
          ],
        }
      );
    }

    const done = (request.completionEvents || []).find((e) => e.type === "SOW_COMPLETED");
    if (done) {
      done.quantity = to;
      const meta = { ...(done.meta || {}) };
      if (meta.sowedQuantity != null) meta.sowedQuantity = to;
      if (isExcess) {
        if (meta.excessPlants != null) meta.excessPlants = to;
        if (meta.remainingUncovered != null) meta.remainingUncovered = to;
      }
      done.meta = meta;
      request.markModified("completionEvents");
    }
    pushEvent(request, {
      type: "NOTE",
      by: adminId,
      quantity: edit.addPlants,
      unit: "plants",
      message: `Plants sowed edited ${from} → ${to} (${edit.addPlants > 0 ? "+" : ""}${edit.addPlants})`,
      meta: { ...result, editType: "SOW_ENTRY_EDITED", fromPlants: from, toPlants: to },
    });
    await request.save();
    console.log(
      `APPLIED · plants ${from} → ${result.plantsSowed} · actual ${result.actualPlants} · mort ${result.expectedMortality}`
    );
  }

  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

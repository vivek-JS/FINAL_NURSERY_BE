/**
 * Delete a secondary inward line: undo slot sync, drop FIFO ledger row, pull subdoc.
 *
 * Usage:
 *   node scripts/delete-secondary-inward.js --batchId=<id> --inwardId=<id> [--dry-run]
 *   node scripts/delete-secondary-inward.js --batchId=<id> --inwardIds=id1,id2 [--dry-run]
 */
import mongoose from "mongoose";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import PlantOutward from "../models/plantOutward.model.js";
import DispatchBatch from "../models/dispatchBatch.model.js";
import SecondaryDispatchAvailability from "../models/secondaryDispatchAvailability.model.js";
import { undoSecondaryInwardFullSlotSync } from "../services/secondaryShedSlotStock.service.js";
import { recordShedActivity, SHED_ACTIVITY_ACTIONS } from "../services/shedActivity.service.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "../.env") });

function parseArgs(argv) {
  const out = { dryRun: false, inwardIds: [] };
  for (const arg of argv) {
    if (arg === "--dry-run") out.dryRun = true;
    else if (arg.startsWith("--batchId=")) out.batchId = arg.slice("--batchId=".length);
    else if (arg.startsWith("--inwardId=")) out.inwardIds.push(arg.slice("--inwardId=".length));
    else if (arg.startsWith("--inwardIds=")) {
      out.inwardIds.push(...arg.slice("--inwardIds=".length).split(",").map((s) => s.trim()).filter(Boolean));
    }
  }
  return out;
}

async function removeFromLedger(session, batchId, secondaryInwardId, plantsRemoved) {
  const doc = await SecondaryDispatchAvailability.findOne({ dispatchBatchId: batchId }).session(session);
  if (!doc) return { removed: 0 };

  const line = (doc.fifoLines || []).find(
    (l) => String(l.secondaryInwardId) === String(secondaryInwardId)
  );
  if (!line) return { removed: 0, skipped: "no_fifo_line" };

  const prevTotal = doc.totalAvailablePlants;
  const qty = Math.max(0, Number(line.remainingPlants) || 0);
  doc.fifoLines = (doc.fifoLines || []).filter(
    (l) => String(l.secondaryInwardId) !== String(secondaryInwardId)
  );
  doc.recalcTotal();
  doc.availabilityTrail.unshift({
    action: "REMOVE_SECONDARY_INWARD",
    activityName: "Secondary inward deleted",
    quantity: qty,
    previousTotalAvailable: prevTotal,
    newTotalAvailable: doc.totalAvailablePlants,
    reason: `Removed secondary inward ${secondaryInwardId} (${plantsRemoved} plants)`,
    secondaryInwardId,
  });
  await doc.save({ session });
  return { removed: qty };
}

async function deleteOneInward({ batchId, inwardId, dryRun }) {
  const po = await PlantOutward.findOne({ batchId });
  if (!po) throw new Error(`PlantOutward not found for batch ${batchId}`);

  const siSub = po.secondaryInward.id(inwardId);
  if (!siSub) throw new Error(`Secondary inward ${inwardId} not found on batch ${batchId}`);

  const siPlain = typeof siSub.toObject === "function" ? siSub.toObject() : siSub;
  const avail = Math.max(0, Number(siPlain.availableQuantity) || 0);
  const total = Math.max(0, Number(siPlain.totalQuantity) || 0);
  const synced = Math.max(0, Number(siPlain.slotStockSyncedPlants) || 0);

  if (avail < total) {
    throw new Error(
      `Cannot delete: ${avail}/${total} plants still available — dispatch or transfer may exist`
    );
  }

  const batchLean = await DispatchBatch.findById(batchId).lean();
  const preview = {
    batchId: String(batchId),
    inwardId: String(inwardId),
    size: siPlain.size,
    totalQuantity: total,
    slotStockSyncedPlants: synced,
    linkedBookingSlotId: siPlain.linkedBookingSlotId ? String(siPlain.linkedBookingSlotId) : null,
    lagwadDate: siPlain.secondaryInwardDate,
  };

  if (dryRun) {
    console.log("[dry-run] would delete:", preview);
    return preview;
  }

  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    if (synced > 0) {
      const undo = await undoSecondaryInwardFullSlotSync({
        session,
        batchId,
        secondaryInwardId: inwardId,
        batchLean,
        siPlain,
      });
      console.log("slot undo:", undo);
    }

    await removeFromLedger(session, batchId, inwardId, total);

    await PlantOutward.updateOne(
      { batchId },
      { $pull: { secondaryInward: { _id: inwardId } } },
      { session }
    );

    await recordShedActivity({
      batchId,
      stage: "secondary_inward",
      subdocId: inwardId,
      action: SHED_ACTIVITY_ACTIONS.SECONDARY_LAGWAD_RECORDED,
      activityName: `लागवड नोंद रद्द · ${total} रोप · ${siPlain.size || ""}`,
      quantity: total,
      previousValue: {
        secondaryInwardDate: siPlain.secondaryInwardDate,
        expectedReadyDate: siPlain.expectedReadyDate,
      },
      newValue: null,
      reason: "Admin delete secondary inward",
      session,
    });

    await session.commitTransaction();
    console.log("deleted:", preview);
    return preview;
  } catch (err) {
    await session.abortTransaction();
    throw err;
  } finally {
    session.endSession();
  }
}

async function main() {
  const { batchId, inwardIds, dryRun } = parseArgs(process.argv.slice(2));
  if (!batchId || !inwardIds.length) {
    console.error(
      "Usage: node scripts/delete-secondary-inward.js --batchId=<id> --inwardId=<id> [--dry-run]"
    );
    process.exit(1);
  }

  const uri = process.env.MONGO_URL || process.env.MONGODB_URI;
  if (!uri) throw new Error("Set MONGO_URL or MONGODB_URI");

  await mongoose.connect(uri);

  for (const inwardId of inwardIds) {
    await deleteOneInward({ batchId, inwardId, dryRun });
  }

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

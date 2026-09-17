/**
 * Apply SB178 lagwad 28 Aug → 20 Aug: undo old slot, relink, resync.
 * Usage: node scripts/apply-sb178-lagwad-change.js
 */
import mongoose from "mongoose";
import dotenv from "dotenv";
import moment from "moment";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "../.env") });

import PlantOutward from "../models/plantOutward.model.js";
import DispatchBatch from "../models/dispatchBatch.model.js";
import PlantSlot from "../models/slots.model.js";
import {
  undoSecondaryInwardFullSlotSync,
  syncSecondaryInwardSlotStockAdd,
  resolveBookingSlotIdForSecondaryBatch,
} from "../services/secondaryShedSlotStock.service.js";

const BATCH_NUMBER = "SB178";
const NEW_LAGWAD = "2026-08-20";

async function slotKpi(slotId) {
  const doc = await PlantSlot.findOne({
    "subtypeSlots.slots._id": new mongoose.Types.ObjectId(String(slotId)),
  }).lean();
  for (const st of doc?.subtypeSlots || []) {
    const sl = (st.slots || []).find((s) => String(s._id) === String(slotId));
    if (sl) {
      return {
        window: `${sl.startDay} – ${sl.endDay}`,
        actualReadyPlants: sl.actualReadyPlants,
        actualPlants: sl.actualPlants,
      };
    }
  }
  return null;
}

async function main() {
  const uri = process.env.MONGO_URL || process.env.MONGODB_URI;
  if (!uri) throw new Error("No MONGO_URL");
  await mongoose.connect(uri);

  const batchLean = await DispatchBatch.findOne({ batchNumber: BATCH_NUMBER }).lean();
  if (!batchLean) throw new Error(`${BATCH_NUMBER} not found`);

  const poDoc = await PlantOutward.findOne({ batchId: batchLean._id });
  if (!poDoc?.secondaryInward?.length) {
    throw new Error("No secondary inward on plant outward");
  }

  const siSub = poDoc.secondaryInward[0];
  if (!siSub) throw new Error("Secondary inward subdoc not found");

  const secondaryInwardId = siSub._id;
  const oldSlotId = String(siSub.linkedBookingSlotId);
  const secDays = Number(batchLean.secondaryPlantReadyDays) || 30;
  const newLagwad = moment(NEW_LAGWAD).startOf("day");
  const newExpected = newLagwad.clone().add(secDays, "days");

  const newSlotId = await resolveBookingSlotIdForSecondaryBatch(
    batchLean,
    newExpected.toDate()
  );
  if (!newSlotId) {
    throw new Error(`No slot for ready date ${newExpected.format("YYYY-MM-DD")}`);
  }

  const before = {
    lagwad: moment(siSub.secondaryInwardDate).format("DD MMM YYYY"),
    expectedReady: moment(siSub.expectedReadyDate).format("DD MMM YYYY"),
    linkedSlot: oldSlotId,
    oldSlotKpi: await slotKpi(oldSlotId),
    newSlotKpiBefore: await slotKpi(newSlotId),
  };

  console.log("Applying SB178 lagwad change...");
  console.log("Before:", JSON.stringify(before, null, 2));

  const session = await mongoose.startSession();
  let undoResult;
  let syncResult;

  try {
    await session.withTransaction(async () => {
      const siPlain = siSub.toObject();

      undoResult = await undoSecondaryInwardFullSlotSync({
        session,
        batchId: batchLean._id,
        secondaryInwardId,
        batchLean,
        siPlain,
        performedBy: null,
      });

      siSub.secondaryInwardDate = newLagwad.toDate();
      siSub.expectedReadyDate = newExpected.toDate();
      siSub.linkedBookingSlotId = newSlotId;
      siSub.slotStockSyncedPlants = 0;

      await PlantOutward.updateOne(
        { _id: poDoc._id, "secondaryInward._id": secondaryInwardId },
        {
          $set: {
            "secondaryInward.$.secondaryInwardDate": newLagwad.toDate(),
            "secondaryInward.$.expectedReadyDate": newExpected.toDate(),
            "secondaryInward.$.linkedBookingSlotId": newSlotId,
            "secondaryInward.$.slotStockSyncedPlants": 0,
          },
        },
        { session }
      );

      const siPlainAfter = {
        ...siPlain,
        secondaryInwardDate: newLagwad.toDate(),
        expectedReadyDate: newExpected.toDate(),
        linkedBookingSlotId: newSlotId,
        slotStockSyncedPlants: 0,
      };

      syncResult = await syncSecondaryInwardSlotStockAdd({
        session,
        batchId: batchLean._id,
        secondaryInwardId,
        batchLean,
        siPlain: siPlainAfter,
        dispatchEligible: true,
        force: true,
        performedBy: null,
      });
    });
  } finally {
    await session.endSession();
  }

  const poAfter = await PlantOutward.findOne({ batchId: batchLean._id }).lean();
  const siAfter = poAfter?.secondaryInward?.[0];

  const after = {
    lagwad: moment(siAfter.secondaryInwardDate).format("DD MMM YYYY"),
    expectedReady: moment(siAfter.expectedReadyDate).format("DD MMM YYYY"),
    linkedSlot: String(siAfter.linkedBookingSlotId),
    synced: siAfter.slotStockSyncedPlants,
    oldSlotKpi: await slotKpi(oldSlotId),
    newSlotKpi: await slotKpi(newSlotId),
  };

  console.log("\nUndo result:", undoResult);
  console.log("Sync result:", syncResult);
  console.log("\nAfter:", JSON.stringify(after, null, 2));
  console.log("\n✓ SB178 lagwad change applied.");

  await mongoose.disconnect();
}

main().catch((e) => {
  console.error("FAILED:", e);
  process.exit(1);
});

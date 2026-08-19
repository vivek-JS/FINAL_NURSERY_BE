/**
 * Revert manual sellable bypass on Aug 2026 lagwad lines.
 * Restores calendar expectedReadyDate and actualReady on slots (calendar-only).
 *
 *   node scripts/revert-lagwad-bypass-prod.mjs           # dry-run
 *   node scripts/revert-lagwad-bypass-prod.mjs --apply   # PROD
 */
import dotenv from "dotenv";
import mongoose from "mongoose";
import moment from "moment";
import path from "path";
import { fileURLToPath } from "url";
import PlantOutward from "../models/plantOutward.model.js";
import DispatchBatch from "../models/dispatchBatch.model.js";
import PlantSlot from "../models/slots.model.js";
import {
  expectedReadyDateForSecondarySize,
  secondaryInwardCalendarReady,
} from "../services/secondaryShedSlotStock.service.js";
import { applyStockFieldUpdates } from "../utility/slotStockTrail.js";
import { splitLagwadQtyForSlot } from "../utility/lagwadSlotPlantsSplit.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "../.env") });

const APPLY = process.argv.includes("--apply");
const BATCH_NUMBERS = ["SB-307", "SB-68", "SB-98", "SB-128"];

function uri() {
  const url = process.env.PROD_MONGO_URL;
  if (!url) throw new Error("PROD_MONGO_URL missing in .env");
  return url;
}

async function main() {
  console.log(
    APPLY
      ? "=== APPLY — revert lagwad bypass on PROD ==="
      : "=== DRY RUN — revert lagwad bypass ==="
  );
  await mongoose.connect(uri());

  const todayStart = moment().startOf("day");
  const batches = await DispatchBatch.find({
    batchNumber: { $in: BATCH_NUMBERS },
  })
    .select("batchNumber secondaryPlantReadyDays")
    .lean();

  /** slotId → ready increment from calendar-eligible lines only */
  const slotReadyTarget = new Map();
  let lineReverts = 0;

  for (const batch of batches) {
    const po = await PlantOutward.findOne({ batchId: batch._id });
    if (!po) continue;

    for (const si of po.secondaryInward || []) {
      const avail = Number(si.availableQuantity) || 0;
      if (avail < 1) continue;

      const inwardDate = si.secondaryInwardDate;
      const calendarReady = expectedReadyDateForSecondarySize(
        inwardDate,
        si.size || "R1",
        batch
      );
      const hadBypass = si.readinessBypassAt != null;

      if (!hadBypass && !si.readinessBypassReason) {
        console.log(`[skip] SB ${batch.batchNumber}: no bypass to clear`);
        continue;
      }

      const calReadyStr = calendarReady
        ? moment(calendarReady).format("YYYY-MM-DD")
        : "—";
      console.log(
        `[revert] SB ${batch.batchNumber}: bypass cleared · expectedReady → ${calReadyStr} · avail ${avail.toLocaleString()}`
      );
      lineReverts++;

      if (APPLY) {
        si.readinessBypassAt = null;
        si.readinessBypassBy = null;
        si.readinessBypassReason = "";
        if (calendarReady) {
          si.expectedReadyDate = calendarReady;
        }
      }

      const slotId = si.linkedBookingSlotId
        ? String(si.linkedBookingSlotId)
        : null;
      const synced = Math.max(0, Number(si.slotStockSyncedPlants) || 0);
      const siPlain = si.toObject();
      const siForCalendar = {
        ...siPlain,
        readinessBypassAt: null,
        expectedReadyDate: calendarReady ?? siPlain.expectedReadyDate,
      };
      const calendarEligible = secondaryInwardCalendarReady(
        siForCalendar,
        batch,
        todayStart
      );
      const readyPortion = calendarEligible
        ? splitLagwadQtyForSlot(synced).actualPlants
        : 0;

      if (slotId && readyPortion > 0) {
        slotReadyTarget.set(
          slotId,
          (slotReadyTarget.get(slotId) || 0) + readyPortion
        );
      }
    }

    if (APPLY && po.isModified()) {
      await po.save({ validateBeforeSave: true });
    }
  }

  console.log("\n--- Slot actualReady (calendar-only sellable) ---");
  const slotIds = [...new Set([...slotReadyTarget.keys()])];
  if (slotIds.length === 0) {
    // Still need to zero slots that had forced ready from import
    for (const batch of batches) {
      const po = await PlantOutward.findOne({ batchId: batch._id }).lean();
      for (const si of po?.secondaryInward || []) {
        if (si.linkedBookingSlotId) {
          slotIds.push(String(si.linkedBookingSlotId));
        }
      }
    }
  }

  const uniqueSlotIds = [...new Set(slotIds)];
  let slotUpdates = 0;

  for (const slotId of uniqueSlotIds) {
    const plantSlot = await PlantSlot.findOne({
      "subtypeSlots.slots._id": slotId,
    });
    if (!plantSlot) {
      console.log(`[missing slot] ${slotId}`);
      continue;
    }

    let slot = null;
    for (const st of plantSlot.subtypeSlots || []) {
      const s = st.slots.id(slotId);
      if (s) slot = s;
    }
    if (!slot) continue;

    const prevReady = Math.max(0, Number(slot.actualReadyPlants) || 0);
    const targetReady = slotReadyTarget.get(slotId) || 0;

    if (prevReady === targetReady) {
      console.log(
        `[skip slot] ${slotId}: actualReady already ${targetReady.toLocaleString()}`
      );
      continue;
    }

    console.log(
      `[slot] ${slotId}: actualReady ${prevReady.toLocaleString()} → ${targetReady.toLocaleString()} (sellable = actual 90% only, calendar ready)`
    );
    slotUpdates++;

    if (APPLY) {
      applyStockFieldUpdates(
        slot,
        { actualReadyPlants: targetReady },
        undefined,
        `Revert bypass · calendar-only sellable ready ${targetReady}`
      );
      await plantSlot.save({ validateBeforeSave: true });
    }
  }

  console.log("\n--- Summary ---");
  console.log(`Bypass reverts: ${lineReverts}, slot actualReady fixes: ${slotUpdates}`);
  if (!APPLY && (lineReverts > 0 || slotUpdates > 0)) {
    console.log("Re-run with --apply to write PROD.");
  }

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

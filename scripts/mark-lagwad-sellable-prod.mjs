/**
 * Mark Aug 2026 lagwad lines sellable (readiness bypass) without relocating slots.
 *
 *   node scripts/mark-lagwad-sellable-prod.mjs           # dry-run
 *   node scripts/mark-lagwad-sellable-prod.mjs --apply     # PROD
 */
import dotenv from "dotenv";
import mongoose from "mongoose";
import moment from "moment";
import path from "path";
import { fileURLToPath } from "url";
import PlantOutward from "../models/plantOutward.model.js";
import DispatchBatch from "../models/dispatchBatch.model.js";
import {
  computeSecondaryDispatchEligibility,
} from "../services/secondaryVehicleLoad.service.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "../.env") });

const APPLY = process.argv.includes("--apply");
const BATCH_NUMBERS = ["SB-307", "SB-68", "SB-98", "SB-128"];
const BYPASS_REASON = "Marked sellable — lagwad Aug 2026 diary import";

function uri() {
  const url = process.env.PROD_MONGO_URL;
  if (!url) throw new Error("PROD_MONGO_URL missing in .env");
  return url;
}

async function main() {
  console.log(
    APPLY
      ? "=== APPLY — mark lagwad sellable on PROD ==="
      : "=== DRY RUN — mark lagwad sellable ==="
  );
  await mongoose.connect(uri());

  const batches = await DispatchBatch.find({
    batchNumber: { $in: BATCH_NUMBERS },
  })
    .select("batchNumber secondaryPlantReadyDays")
    .lean();

  const today = moment().startOf("day");
  let updates = 0;
  let skips = 0;

  for (const batch of batches) {
    const po = await PlantOutward.findOne({ batchId: batch._id });
    if (!po) {
      console.log(`[missing] SB ${batch.batchNumber} no PlantOutward`);
      continue;
    }

    const secDays = Number(batch.secondaryPlantReadyDays) || 0;

    for (const si of po.secondaryInward || []) {
      const avail = Number(si.availableQuantity) || 0;
      if (avail < 1) continue;

      const eligBefore = computeSecondaryDispatchEligibility(
        si.toObject(),
        secDays,
        today
      );

      if (si.readinessBypassAt && eligBefore.dispatchEligible) {
        console.log(
          `[skip] SB ${batch.batchNumber} inward ${si._id}: already sellable (bypass ${moment(si.readinessBypassAt).format("YYYY-MM-DD")})`
        );
        skips++;
        continue;
      }

      const readyBefore = si.expectedReadyDate
        ? moment(si.expectedReadyDate).format("YYYY-MM-DD")
        : "—";
      console.log(
        `[mark] SB ${batch.batchNumber}: avail ${avail.toLocaleString()} · ready was ${readyBefore} · eligible ${eligBefore.dispatchEligible} → true · slot ${si.linkedBookingSlotId || "—"}`
      );
      updates++;

      if (APPLY) {
        const now = new Date();
        si.readinessBypassAt = now;
        si.expectedReadyDate = now;
        si.readinessBypassReason = BYPASS_REASON;
      }
    }

    if (APPLY && po.isModified()) {
      await po.save({ validateBeforeSave: true });
    }
  }

  console.log("\n--- Summary ---");
  console.log(`Lines to mark sellable: ${updates}, already sellable: ${skips}`);
  if (!APPLY && updates > 0) {
    console.log("Re-run with --apply to write PROD.");
  }

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

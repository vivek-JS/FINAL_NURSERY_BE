/**
 * Rename lagwad import batches to SB- prefix on PROD.
 *
 *   node scripts/rename-lagwad-batches-sb-prod.mjs           # dry-run
 *   node scripts/rename-lagwad-batches-sb-prod.mjs --apply   # PROD
 */
import dotenv from "dotenv";
import mongoose from "mongoose";
import path from "path";
import { fileURLToPath } from "url";
import DispatchBatch from "../models/dispatchBatch.model.js";
import PlantOutward from "../models/plantOutward.model.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "../.env") });

const APPLY = process.argv.includes("--apply");

const RENAMES = [
  { from: "307", to: "SB-307" },
  { from: "68", to: "SB-68" },
  { from: "98", to: "SB-98" },
  { from: "128", to: "SB-128" },
];

function uri() {
  const url = process.env.PROD_MONGO_URL;
  if (!url) throw new Error("PROD_MONGO_URL missing in .env");
  return url;
}

async function main() {
  console.log(APPLY ? "=== APPLY — rename batches SB-* ===" : "=== DRY RUN — rename batches ===");
  await mongoose.connect(uri());

  let updates = 0;
  let skips = 0;

  for (const { from, to } of RENAMES) {
    const batch = await DispatchBatch.findOne({ batchNumber: from });
    if (!batch) {
      const already = await DispatchBatch.findOne({ batchNumber: to }).select("batchNumber");
      if (already) {
        console.log(`[skip] ${from} → already ${to}`);
        skips++;
      } else {
        console.log(`[missing] batch ${from} not found`);
      }
      continue;
    }

    const clash = await DispatchBatch.findOne({ batchNumber: to, _id: { $ne: batch._id } });
    if (clash) {
      console.log(`[error] cannot rename ${from} → ${to}: number already used`);
      continue;
    }

    console.log(`[rename] ${from} → ${to} (id ${batch._id})`);
    updates++;

    if (APPLY) {
      await DispatchBatch.updateOne({ _id: batch._id }, { $set: { batchNumber: to } });

      const po = await PlantOutward.findOne({ batchId: batch._id });
      if (po) {
        for (const si of po.secondaryInward || []) {
          const remarks = String(si.remarks || "");
          if (remarks.includes(`batch ${from}`)) {
            si.remarks = remarks.replace(`batch ${from}`, `batch ${to}`);
          }
        }
        if (po.isModified()) {
          await po.save({ validateBeforeSave: true });
        }
      }
    }
  }

  console.log("\n--- Summary ---");
  console.log(`Renames: ${updates}, skipped: ${skips}`);
  if (!APPLY && updates > 0) {
    console.log("Re-run with --apply to write PROD.");
  }

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

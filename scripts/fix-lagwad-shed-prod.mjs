/**
 * Fix pollyhouse on Aug 2026 lagwad secondary-inward lines + shade #23 display name.
 *
 *   node scripts/fix-lagwad-shed-prod.mjs           # dry-run
 *   node scripts/fix-lagwad-shed-prod.mjs --apply   # PROD
 */
import dotenv from "dotenv";
import mongoose from "mongoose";
import path from "path";
import { fileURLToPath } from "url";
import PlantOutward from "../models/plantOutward.model.js";
import DispatchBatch from "../models/dispatchBatch.model.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "../.env") });

const APPLY = process.argv.includes("--apply");

const SHED_23_NAME = "23 no (विशाल गड)";
const SHED_23_NUMBER = "23";
const SHED_23_POLLYHOUSE = `${SHED_23_NAME} (${SHED_23_NUMBER})`;

const SHED_TORNA_NAME = "Torna (तोरणा)";
const SHED_TORNA_NUMBER = "5";
const SHED_TORNA_POLLYHOUSE = `${SHED_TORNA_NAME} (${SHED_TORNA_NUMBER})`;

const BATCH_SHED = {
  "SB-307": SHED_23_POLLYHOUSE,
  "SB-68": SHED_23_POLLYHOUSE,
  "SB-98": SHED_23_POLLYHOUSE,
  "SB-128": SHED_TORNA_POLLYHOUSE,
};

function uri() {
  const url = process.env.PROD_MONGO_URL;
  if (!url) throw new Error("PROD_MONGO_URL missing in .env");
  return url;
}

async function main() {
  console.log(APPLY ? "=== APPLY — fix lagwad sheds on PROD ===" : "=== DRY RUN — lagwad shed fix ===");
  await mongoose.connect(uri());

  const shadesCol = mongoose.connection.db.collection("shades");
  const shade23 = await shadesCol.findOne({ number: SHED_23_NUMBER });
  if (shade23) {
    const oldName = String(shade23.name || "").trim();
    const needs = oldName !== SHED_23_NAME;
    console.log(
      `\nShade #${SHED_23_NUMBER}: ${needs ? `[update] "${oldName}" → "${SHED_23_NAME}"` : `[ok] "${oldName}"`}`
    );
    if (APPLY && needs) {
      await shadesCol.updateOne({ _id: shade23._id }, { $set: { name: SHED_23_NAME } });
    }
  } else {
    console.warn(`WARNING: shade #${SHED_23_NUMBER} not found`);
  }

  const batches = await DispatchBatch.find({
    batchNumber: { $in: Object.keys(BATCH_SHED) },
  })
    .select("batchNumber")
    .lean();
  const batchIdByNumber = new Map(batches.map((b) => [String(b.batchNumber), b._id]));

  console.log("\n--- Secondary inward pollyhouse ---");
  let lineUpdates = 0;
  let lineSkips = 0;

  for (const [batchNumber, targetPollyhouse] of Object.entries(BATCH_SHED)) {
    const batchId = batchIdByNumber.get(batchNumber);
    if (!batchId) {
      console.log(`[missing batch] SB ${batchNumber} not in DB`);
      continue;
    }

    const po = await PlantOutward.findOne({ batchId }).lean();
    if (!po?.secondaryInward?.length) {
      console.log(`[no inward] SB ${batchNumber}`);
      continue;
    }

    for (const si of po.secondaryInward) {
      const oldPh = String(si.pollyhouse || "").trim();
      const plants = Number(si.availableQuantity ?? si.totalQuantity) || 0;
      if (oldPh === targetPollyhouse) {
        console.log(
          `[skip] SB ${batchNumber} inward ${si._id}: already "${oldPh}" · ${plants.toLocaleString()} plants`
        );
        lineSkips++;
        continue;
      }
      console.log(
        `[fix] SB ${batchNumber}: "${oldPh || "—"}" → "${targetPollyhouse}" · ${plants.toLocaleString()} plants`
      );
      lineUpdates++;
      if (APPLY) {
        await PlantOutward.updateOne(
          { batchId, "secondaryInward._id": si._id },
          { $set: { "secondaryInward.$.pollyhouse": targetPollyhouse } }
        );
      }
    }
  }

  console.log("\n--- Summary ---");
  console.log(`Pollyhouse: ${lineUpdates} update(s), ${lineSkips} already correct`);
  if (!APPLY && lineUpdates > 0) {
    console.log("Re-run with --apply to write PROD.");
  }

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

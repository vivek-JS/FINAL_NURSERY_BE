/**
 * Backfill primaryUnit on Ram Agri varieties missing units (blocks PO / GRN / batches).
 *
 * Usage: node scripts/backfill-ram-agri-variety-units-local.js [--dry-run]
 */
import dotenv from "dotenv";
import mongoose from "mongoose";
import path from "path";
import { fileURLToPath } from "url";
import { backfillMissingVarietyUnits } from "../services/ramAgriVarietyUnit.service.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });

const dryRun = process.argv.includes("--dry-run");

async function main() {
  await mongoose.connect(process.env.MONGO_URL || process.env.MONGODB_URI);
  console.log(dryRun ? "[dry-run] Scanning..." : "Backfilling missing variety units...");

  if (dryRun) {
    const RamAgriInputsProduct = (await import("../models/ramAgriInputsProduct.model.js")).default;
    const crops = await RamAgriInputsProduct.find({}).lean();
    const missing = [];
    for (const c of crops) {
      for (const v of c.varieties || []) {
        if (!v.primaryUnit) missing.push(`${c.cropName} / ${v.name}`);
      }
    }
    console.log(`Would update ${missing.length} varieties`);
    console.log(missing.slice(0, 20).join("\n"));
    if (missing.length > 20) console.log(`... and ${missing.length - 20} more`);
    await mongoose.disconnect();
    return;
  }

  const result = await backfillMissingVarietyUnits();
  console.log(
    `Updated ${result.updated} varieties with default unit ${result.defaultUnit.name} (${result.defaultUnit._id})`
  );
  const madhumati = result.details.filter((d) => /madhumati/i.test(d.variety));
  if (madhumati.length) console.log("Madhumati:", madhumati);
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

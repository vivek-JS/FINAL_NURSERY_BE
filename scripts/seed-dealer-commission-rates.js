/**
 * Seed / sync dealer commission rates from PlantCms subtypes.
 * Default ₹1/plant; Papaya 15 NOA and 15 R15 are not overwritten on bulk-default.
 *
 * Usage:
 *   node scripts/seed-dealer-commission-rates.js sync
 *   node scripts/seed-dealer-commission-rates.js bulk-default
 */
import dotenv from "dotenv";
import mongoose from "mongoose";
import {
  syncCommissionRatesFromPlants,
  bulkDefaultCommissionRates,
} from "../services/dealerCommission.service.js";

dotenv.config();

const action = process.argv[2] || "sync";

async function main() {
  const mongoUrl =
    process.env.MONGO_URL ||
    process.env.STAGE_MONGO_URL ||
    process.env.MONGODB_URI ||
    process.env.PROD_MONGO_URL;

  if (!mongoUrl) {
    console.error("Missing MONGO_URL (or STAGE_MONGO_URL / MONGODB_URI)");
    process.exit(1);
  }

  await mongoose.connect(mongoUrl);
  console.log("Connected to MongoDB");

  if (action === "bulk-default") {
    const result = await bulkDefaultCommissionRates();
    console.log("Bulk default complete:", result);
  } else {
    const result = await syncCommissionRatesFromPlants();
    console.log("Sync complete:", result);
  }

  await mongoose.disconnect();
  console.log("Done");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

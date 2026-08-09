/**
 * One-time migration: mark pre–30-Jul-2026 Ram Agri orders as old era.
 *
 * Dry-run (default):
 *   node scripts/mark-agri-orders-old-era.js
 * Apply:
 *   node scripts/mark-agri-orders-old-era.js --apply
 * Production:
 *   node scripts/mark-agri-orders-old-era.js --prod --apply
 */
import mongoose from "mongoose";
import dotenv from "dotenv";
import { fileURLToPath } from "url";
import path from "path";
import AgriSalesOrder from "../models/agriSalesOrder.model.js";
import { AGRI_OLD_CUTOFF_END } from "../utils/agriOrderEra.util.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });

const isProd = process.argv.includes("--prod");
const apply = process.argv.includes("--apply");
const mongoUrl = isProd
  ? process.env.PROD_MONGO_URL
  : process.env.STAGE_MONGO_URL || process.env.MONGO_URL || process.env.MONGO_URI;

if (!mongoUrl) {
  console.error("No Mongo URL. Set PROD_MONGO_URL / STAGE_MONGO_URL / MONGO_URL in .env");
  process.exit(1);
}

function effectiveBookedDate(doc) {
  if (doc.orderDate) return new Date(doc.orderDate);
  if (doc.createdAt) return new Date(doc.createdAt);
  return null;
}

function isOnOrBeforeCutoff(doc) {
  const d = effectiveBookedDate(doc);
  if (!d || Number.isNaN(d.getTime())) return false;
  return d.getTime() <= AGRI_OLD_CUTOFF_END.getTime();
}

console.log(`Target: ${isProd ? "PROD" : "STAGE/DEV"} | mode: ${apply ? "APPLY" : "DRY-RUN"}`);
console.log(`Cutoff (inclusive): ${AGRI_OLD_CUTOFF_END.toISOString()}`);

await mongoose.connect(mongoUrl);
console.log("Connected.");

const allOrders = await AgriSalesOrder.find({})
  .select("_id orderNumber orderDate createdAt isOld displayOrderKey")
  .lean();

const toMark = allOrders
  .filter((doc) => !doc.isOld && isOnOrBeforeCutoff(doc))
  .sort((a, b) => {
    const da = effectiveBookedDate(a)?.getTime() || 0;
    const db = effectiveBookedDate(b)?.getTime() || 0;
    if (da !== db) return da - db;
    return String(a._id).localeCompare(String(b._id));
  });

const alreadyOld = allOrders.filter((d) => d.isOld).length;
const newEra = allOrders.filter((d) => !d.isOld && !isOnOrBeforeCutoff(d)).length;

console.log(`Total orders: ${allOrders.length}`);
console.log(`Already isOld: ${alreadyOld}`);
console.log(`New era (after cutoff): ${newEra}`);
console.log(`To mark old: ${toMark.length}`);

if (toMark.length > 0) {
  console.log("Sample (first 5):");
  toMark.slice(0, 5).forEach((o, i) => {
    console.log(
      `  ${i + 1}. ${o.orderNumber} booked=${effectiveBookedDate(o)?.toISOString()} key→${i + 1}`
    );
  });
}

if (!apply) {
  console.log("\nDry-run only. Re-run with --apply to write changes.");
  await mongoose.disconnect();
  process.exit(0);
}

let updated = 0;
for (let i = 0; i < toMark.length; i++) {
  const doc = toMark[i];
  await AgriSalesOrder.updateOne(
    { _id: doc._id },
    { $set: { isOld: true, displayOrderKey: i + 1 } }
  );
  updated++;
}

console.log(`\nApplied: ${updated} orders marked isOld=true with displayOrderKey 1..${updated}`);
await mongoose.disconnect();
console.log("Done.");

/**
 * One-time migration: copy legacy single-product root fields into lineItems[0]
 * for AgriSalesOrder documents that have no lineItems array.
 *
 * Usage (from FINAL_NURSERY_BE): node scripts/backfill-agri-sales-line-items.js
 */
import mongoose from "mongoose";
import dotenv from "dotenv";
import AgriSalesOrder from "../models/agriSalesOrder.model.js";

dotenv.config();

const buildLineFromDoc = (doc) => {
  if (doc.isRamAgriProduct) {
    return {
      sortOrder: 0,
      isRamAgriProduct: true,
      productId: null,
      ramAgriCropId: doc.ramAgriCropId,
      ramAgriVarietyId: doc.ramAgriVarietyId,
      ramAgriCropName: doc.ramAgriCropName || "",
      ramAgriVarietyName: doc.ramAgriVarietyName || "",
      primaryUnit: doc.primaryUnit || null,
      secondaryUnit: doc.secondaryUnit || null,
      conversionFactor: doc.conversionFactor ?? 1,
      productName: doc.productName || "Item",
      quantity: doc.quantity,
      rate: doc.rate,
      lineTotal: (doc.quantity || 0) * (doc.rate || 0),
    };
  }
  return {
    sortOrder: 0,
    isRamAgriProduct: false,
    productId: doc.productId,
    ramAgriCropId: null,
    ramAgriVarietyId: null,
    ramAgriCropName: "",
    ramAgriVarietyName: "",
    primaryUnit: null,
    secondaryUnit: null,
    conversionFactor: 1,
    productName: doc.productName || "Item",
    quantity: doc.quantity,
    unit: doc.unit || "pieces",
    rate: doc.rate,
    lineTotal: (doc.quantity || 0) * (doc.rate || 0),
  };
};

async function main() {
  const uri = process.env.MONGO_URI || process.env.MONGODB_URI || process.env.DATABASE_URL;
  if (!uri) {
    console.error("Set MONGO_URI (or MONGODB_URI) in .env");
    process.exit(1);
  }
  await mongoose.connect(uri);
  const cursor = AgriSalesOrder.find({
    $or: [{ lineItems: { $exists: false } }, { lineItems: { $size: 0 } }],
  }).cursor();

  let updated = 0;
  for await (const doc of cursor) {
    if (!doc.quantity || doc.quantity < 1) continue;
    doc.lineItems = [buildLineFromDoc(doc)];
    await doc.save();
    updated += 1;
  }
  console.log(`Backfill complete. Updated ${updated} order(s).`);
  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

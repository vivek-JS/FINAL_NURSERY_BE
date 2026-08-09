/**
 * Remove Plant CMS links (plantId/subtypeId) from all seed products.
 * Does NOT delete products, batches, or currentStock.
 *
 * Usage: node scripts/clear-seed-plant-cms-links-local.js
 */
import dotenv from "dotenv";
import mongoose from "mongoose";
import path from "path";
import { fileURLToPath } from "url";
import Product from "../models/product.model.js";
import Batch from "../models/batch.model.js";
import { clearAllVarietyInventoryLinks } from "../services/ramAgriVarietyInventoryLink.service.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });

const USER_ID = new mongoose.Types.ObjectId("6869ff079e52efe6184aec3a");

await mongoose.connect(process.env.MONGO_URL || process.env.MONGODB_URI);

const before = await Product.find({
  category: { $regex: /^seeds$/i },
  isActive: true,
})
  .select("code plantId subtypeId currentStock")
  .lean();

const linkedBefore = before.filter((p) => p.plantId || p.subtypeId);
const stockBefore = before.reduce((s, p) => s + (Number(p.currentStock) || 0), 0);

console.log(`Before: ${before.length} seed products, ${linkedBefore.length} linked to Plant CMS`);
console.log(`Total seed currentStock: ${stockBefore}`);

const result = await clearAllVarietyInventoryLinks(USER_ID);
console.log("clearAllVarietyInventoryLinks:", result);

const after = await Product.find({
  category: { $regex: /^seeds$/i },
  isActive: true,
})
  .select("code plantId subtypeId currentStock")
  .lean();

const linkedAfter = after.filter((p) => p.plantId || p.subtypeId);
const stockAfter = after.reduce((s, p) => s + (Number(p.currentStock) || 0), 0);

const productIds = after.map((p) => p._id);
const batchSum = await Batch.aggregate([
  { $match: { product: { $in: productIds }, remainingQuantity: { $gt: 0 } } },
  { $group: { _id: null, total: { $sum: "$remainingQuantity" } } },
]);

console.log(`After: ${after.length} seed products, ${linkedAfter.length} linked to Plant CMS`);
console.log(`Total seed currentStock: ${stockAfter} (unchanged: ${stockBefore === stockAfter})`);
console.log(`Batch remaining qty sum: ${batchSum[0]?.total ?? 0}`);

if (linkedAfter.length) {
  console.error("Still linked:", linkedAfter.map((p) => p.code));
  process.exit(1);
}

await mongoose.disconnect();
console.log("Done — all seed Plant CMS links removed; stock preserved.");

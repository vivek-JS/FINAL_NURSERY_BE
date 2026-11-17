/**
 * One-shot: set freePlantsPerCrate = 1 on Watermelon plant CMS docs.
 * Usage: node scripts/setWatermelonFreePerCrate.js
 * Requires MONGO_URI or MONGODB_URI in env / .env
 */
import mongoose from "mongoose";
import PlantCms from "../models/plantCms.model.js";

const uri =
  process.env.MONGO_URL ||
  process.env.MONGO_URI ||
  process.env.MONGODB_URI ||
  process.env.DATABASE ||
  "";

if (!uri) {
  console.error("Set MONGO_URL / MONGO_URI / MONGODB_URI");
  process.exit(1);
}

await mongoose.connect(uri);
const res = await PlantCms.updateMany(
  { name: { $regex: /^watermelon$/i } },
  { $set: { freePlantsPerCrate: 1 } }
);
console.log(
  `Matched ${res.matchedCount}, modified ${res.modifiedCount} watermelon plant(s)`
);
await mongoose.disconnect();

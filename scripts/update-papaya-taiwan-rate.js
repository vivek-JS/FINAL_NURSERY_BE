/**
 * Set PlantCms Papaya subtype Taiwan list price to 23 (e.g. updating from 11).
 * Usage (from FINAL_NURSERY_BE): node scripts/update-papaya-taiwan-rate.js
 */
import mongoose from "mongoose";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import PlantCms from "../models/plantCms.model.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "..", ".env") });

const normalize = (s) => String(s ?? "").trim().toLowerCase();

async function main() {
  const uri = process.env.MONGO_URL || process.env.MONGODB_URI;
  if (!uri) {
    console.error("Missing MONGO_URL or MONGODB_URI in .env");
    process.exit(1);
  }
  await mongoose.connect(uri);
  const plant = await PlantCms.findOne({ name: /^papaya$/i });
  if (!plant) {
    console.error("Plant Papaya not found");
    process.exit(1);
  }
  const subtype = plant.subtypes.find((st) => normalize(st.name) === "taiwan");
  if (!subtype) {
    console.error(
      "Subtype Taiwan not found. Subtypes:",
      plant.subtypes.map((s) => s.name).join(", ")
    );
    process.exit(1);
  }
  subtype.rates = [23];
  await plant.save();
  console.log("OK: Papaya / Taiwan rates ->", subtype.rates);
  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

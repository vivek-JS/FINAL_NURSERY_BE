/**
 * One-shot: Watermelon (water / tarbuj) sowingBuffer + sowingMortality = 12%.
 *   node scripts/set-watermelon-buffer-mortality.mjs
 */
import dotenv from "dotenv";
import mongoose from "mongoose";
import path from "path";
import { fileURLToPath } from "url";
import PlantCms from "../models/plantCms.model.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "../.env") });

async function main() {
  const uri = process.env.PROD_MONGO_URL || process.env.MONGO_URL;
  if (!uri) throw new Error("Missing MONGO_URL / PROD_MONGO_URL");
  await mongoose.connect(uri);
  const filter = { name: { $regex: /water|tarbuj/i } };
  const found = await PlantCms.find(filter).select("_id name sowingBuffer sowingMortality").lean();
  console.log(
    "Matched plants:",
    found.map((p) => `${p.name} buf=${p.sowingBuffer} mort=${p.sowingMortality}`)
  );
  const res = await PlantCms.updateMany(filter, {
    $set: { sowingBuffer: 12, sowingMortality: 12 },
  });
  console.log(`Updated ${res.modifiedCount} of ${res.matchedCount}`);
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

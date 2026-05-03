/**
 * One-time: create empty PlantOutward docs for DispatchBatch rows that have none.
 * Run: node scripts/backfill-plant-outward-shells.js  (requires MONGO_URI in .env)
 */
import mongoose from "mongoose";
import dotenv from "dotenv";
import DispatchBatch from "../models/dispatchBatch.model.js";
import PlantOutward from "../models/plantOutward.model.js";

dotenv.config();

async function main() {
  const uri = process.env.MONGO_URI || process.env.MONGODB_URI || process.env.DATABASE;
  if (!uri) {
    console.error("Set MONGO_URI or MONGODB_URI");
    process.exit(1);
  }
  await mongoose.connect(uri);
  const batches = await DispatchBatch.find({}).select("_id dateAdded").lean();
  let created = 0;
  for (const b of batches) {
    const exists = await PlantOutward.findOne({ batchId: b._id }).select("_id").lean();
    if (exists) continue;
    await PlantOutward.create({
      batchId: b._id,
      dateAdded: b.dateAdded || new Date(),
    });
    created += 1;
    console.log("Created PlantOutward for batch", String(b._id));
  }
  console.log(`Done. Created ${created} shell(s).`);
  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

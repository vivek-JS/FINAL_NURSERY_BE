/**
 * One-time: set secondaryAcknowledgedAt on existing primary outward subdocs where the field is missing.
 * Leaves explicit null (new rows awaiting Accept) untouched.
 *
 * Usage: node scripts/backfill-secondary-acknowledged-at.js
 * Requires MONGO_URI or DATABASE connection string in env (same as app).
 */
import mongoose from "mongoose";
import dotenv from "dotenv";
import PlantOutward from "../models/plantOutward.model.js";

dotenv.config();

const uri = process.env.MONGO_URI || process.env.MONGODB_URI || process.env.DATABASE;

async function main() {
  if (!uri) {
    console.error("Set MONGO_URI (or MONGODB_URI / DATABASE) in .env");
    process.exit(1);
  }
  await mongoose.connect(uri);
  const docs = await PlantOutward.find({});
  let updatedDocs = 0;
  for (const doc of docs) {
    let changed = false;
    for (const po of doc.primaryOutward || []) {
      if (po.secondaryAcknowledgedAt === undefined) {
        po.secondaryAcknowledgedAt = po.primaryOutwardDate || new Date();
        changed = true;
      }
    }
    if (changed) {
      await doc.save();
      updatedDocs += 1;
    }
  }
  console.log(`backfill-secondary-acknowledged-at: updated ${updatedDocs} plant outward documents`);
  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

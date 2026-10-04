/**
 * Move embedded slotTrail arrays off PlantSlot documents that are near 16MB.
 * Usage: node scripts/offload-slot-trails.js
 */
import "dotenv/config";
import mongoose from "mongoose";
import { offloadEmbeddedSlotTrails } from "../utility/slotTrailStore.js";

const MIN_BYTES = 8 * 1024 * 1024;

const uri = process.env.MONGO_URL || process.env.MONGODB_URI || process.env.MONGO_URI;
if (!uri) {
  console.error("Set MONGO_URL");
  process.exit(1);
}

await mongoose.connect(uri);
const fat = await mongoose.connection.db
  .collection("plantslots")
  .aggregate([
    { $project: { bytes: { $bsonSize: "$$ROOT" }, year: 1, plantId: 1 } },
    { $match: { bytes: { $gt: MIN_BYTES } } },
  ])
  .toArray();

console.log(`plant slot files over 8MB: ${fat.length}`);
for (const row of fat) {
  const result = await offloadEmbeddedSlotTrails(row._id);
  console.log(
    JSON.stringify({
      id: String(row._id),
      year: row.year,
      beforeBytes: row.bytes,
      moved: result.moved,
      afterBytes: result.afterBytes,
    })
  );
}
await mongoose.disconnect();

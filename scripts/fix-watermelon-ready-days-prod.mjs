/**
 * Set Watermelon CMS subtypes + calendar slots to plantReadyDays = 18.
 *
 *   node scripts/fix-watermelon-ready-days-prod.mjs
 *   node scripts/fix-watermelon-ready-days-prod.mjs --apply
 */
import dotenv from "dotenv";
import mongoose from "mongoose";
import path from "path";
import { fileURLToPath } from "url";
import PlantCms from "../models/plantCms.model.js";
import PlantSlot from "../models/slots.model.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "../.env") });

const APPLY = process.argv.includes("--apply");
const TARGET_DAYS = 18;

function addDaysDdMmYyyy(sowingDateStr, days) {
  const m = String(sowingDateStr || "").match(/^(\d{2})-(\d{2})-(\d{4})$/);
  if (!m) return null;
  const d = new Date(
    parseInt(m[3], 10),
    parseInt(m[2], 10) - 1,
    parseInt(m[1], 10),
    12,
    0,
    0,
    0
  );
  d.setDate(d.getDate() + Math.max(0, Number(days) || 0));
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  return `${dd}-${mm}-${d.getFullYear()}`;
}

async function countNonTargetSlots(plantId) {
  const rows = await PlantSlot.aggregate([
    { $match: { plantId } },
    { $unwind: "$subtypeSlots" },
    { $unwind: "$subtypeSlots.slots" },
    {
      $match: {
        "subtypeSlots.slots.plantReadyDays": { $ne: TARGET_DAYS },
      },
    },
    { $group: { _id: "$year", count: { $sum: 1 } } },
    { $sort: { _id: 1 } },
  ]);
  return rows;
}

async function main() {
  const uri = process.env.PROD_MONGO_URL || process.env.MONGO_URL;
  if (!uri) throw new Error("PROD_MONGO_URL or MONGO_URL required");

  console.log(
    APPLY
      ? `=== APPLY watermelon ready days = ${TARGET_DAYS} ===`
      : "=== DRY RUN ==="
  );
  await mongoose.connect(uri);

  const plant = await PlantCms.findOne({ name: /^Watermelon$/i });
  if (!plant) throw new Error("Watermelon plant not found in PlantCms");

  const cmsUpdates = [];
  for (const subtype of plant.subtypes || []) {
    if (Number(subtype.plantReadyDays) !== TARGET_DAYS) {
      cmsUpdates.push({
        name: subtype.name,
        from: subtype.plantReadyDays,
        to: TARGET_DAYS,
      });
      if (APPLY) subtype.plantReadyDays = TARGET_DAYS;
    }
  }

  console.log(`CMS subtypes to update: ${cmsUpdates.length}`);
  for (const u of cmsUpdates) {
    console.log(`  ${u.name}: ${u.from} → ${u.to}`);
  }

  if (APPLY && cmsUpdates.length) {
    await plant.save();
    console.log("CMS saved.");
  }

  const before = await countNonTargetSlots(plant._id);
  const slotCount = before.reduce((s, r) => s + r.count, 0);
  console.log(`Slots with plantReadyDays ≠ ${TARGET_DAYS}: ${slotCount}`);
  if (before.length) console.log("By year:", before);

  if (APPLY && slotCount > 0) {
    const res = await PlantSlot.updateMany(
      { plantId: plant._id },
      {
        $set: {
          "subtypeSlots.$[].slots.$[].plantReadyDays": TARGET_DAYS,
        },
      }
    );
    console.log("Slot updateMany:", res);
  }

  if (APPLY) {
    const sowedDocs = await PlantSlot.find({
      plantId: plant._id,
      "subtypeSlots.slots.sowingDate": { $exists: true, $ne: null },
    });
    let readyDateCount = 0;
    for (const doc of sowedDocs) {
      let dirty = false;
      for (const st of doc.subtypeSlots || []) {
        for (const slot of st.slots || []) {
          if (!slot.sowingDate) continue;
          const newReady = addDaysDdMmYyyy(slot.sowingDate, TARGET_DAYS);
          if (newReady && slot.plantReadyDate !== newReady) {
            slot.plantReadyDate = newReady;
            readyDateCount++;
            dirty = true;
          }
        }
      }
      if (dirty) {
        doc.markModified("subtypeSlots");
        await doc.save();
      }
    }
    console.log(`plantReadyDate recalculated: ${readyDateCount}`);
  }

  const after = await countNonTargetSlots(plant._id);
  const remaining = after.reduce((s, r) => s + r.count, 0);
  console.log(`Remaining slots ≠ ${TARGET_DAYS}: ${remaining}`);

  await mongoose.disconnect();
  console.log(
    APPLY ? "Done (applied)." : "Dry run complete — pass --apply to write."
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

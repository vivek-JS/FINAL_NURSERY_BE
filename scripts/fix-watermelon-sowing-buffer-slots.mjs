/**
 * Fix watermelon sowingBuffer (was 10/12%) and diary slot actual vs leftover available.
 * Moves mistaken expectedMortality back into actual. Does not mark orders.
 *
 *   node scripts/fix-watermelon-sowing-buffer-slots.mjs
 *   node scripts/fix-watermelon-sowing-buffer-slots.mjs --apply
 */
import dotenv from "dotenv";
import mongoose from "mongoose";
import path from "path";
import { fileURLToPath } from "url";
import PlantCms from "../models/plantCms.model.js";
import PlantSlot from "../models/slots.model.js";
import SowingRequest from "../models/sowingRequest.model.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "../.env") });

const APPLY = process.argv.includes("--apply");
const TAG = "diary-sow-2026";
const fmt = (n) => Number(n || 0).toLocaleString("en-IN");

async function main() {
  console.log(APPLY ? "=== APPLY watermelon slot/buffer fix ===" : "=== DRY RUN ===");
  await mongoose.connect(process.env.PROD_MONGO_URL);

  const plant = await PlantCms.findOne({ name: "Watermelon" }).select(
    "name sowingBuffer buffer"
  );
  if (!plant) throw new Error("Watermelon not found");
  console.log(
    `CMS sowingBuffer=${plant.sowingBuffer} plant.buffer=${plant.buffer}`
  );

  const diary = await SowingRequest.find({ notes: new RegExp(TAG) })
    .select("requestNumber subtypeName sowedQuantity linkedSlotIds")
    .lean();
  const slotIds = [
    ...new Set(
      diary.flatMap((r) => (r.linkedSlotIds || []).map((id) => String(id)))
    ),
  ];
  console.log(`Diary requests ${diary.length} · linked slots ${slotIds.length}`);

  const docs = await PlantSlot.find({
    "subtypeSlots.slots._id": {
      $in: slotIds.map((id) => new mongoose.Types.ObjectId(id)),
    },
  });

  const plans = [];
  for (const doc of docs) {
    for (const st of doc.subtypeSlots || []) {
      for (const sl of st.slots || []) {
        if (!slotIds.includes(String(sl._id))) continue;
        const sowed = Number(sl.plantsSowed) || 0;
        const actual = Number(sl.actualPlants) || 0;
        const mort = Number(sl.expectedMortality) || 0;
        const avail = Number(sl.availablePlants) || 0;
        let nextActual = actual + mort;
        if (sowed > nextActual) nextActual = sowed;
        const nextMort = 0;
        const nextAvail = nextActual;
        if (nextActual === actual && nextMort === mort && nextAvail === avail) continue;
        plans.push({
          doc,
          stId: st.subtypeId,
          slotId: sl._id,
          startDay: sl.startDay,
          sowed,
          from: { actual, mort, avail },
          to: { actual: nextActual, mort: nextMort, avail: nextAvail },
        });
      }
    }
  }

  console.log(`Slots to rewrite: ${plans.length}`);
  for (const p of plans) {
    console.log(
      `  ${p.startDay} sowed ${fmt(p.sowed)} · actual ${fmt(p.from.actual)}→${fmt(p.to.actual)} · mort ${fmt(p.from.mort)}→${fmt(p.to.mort)} · avail ${fmt(p.from.avail)}→${fmt(p.to.avail)}`
    );
  }

  if (!APPLY) {
    console.log("\nWould set Watermelon sowingBuffer → 10");
    console.log("Re-run with --apply to write PROD.");
    await mongoose.disconnect();
    return;
  }

  plant.sowingBuffer = 10;
  await plant.save();
  console.log("Set Watermelon sowingBuffer = 10");

  for (const p of plans) {
    await PlantSlot.updateOne(
      { _id: p.doc._id, "subtypeSlots.slots._id": p.slotId },
      {
        $set: {
          "subtypeSlots.$[st].slots.$[sl].actualPlants": p.to.actual,
          "subtypeSlots.$[st].slots.$[sl].expectedMortality": p.to.mort,
          "subtypeSlots.$[st].slots.$[sl].availablePlants": p.to.avail,
          "subtypeSlots.$[st].slots.$[sl].availablePlantsMaterialized": true,
        },
      },
      {
        arrayFilters: [
          { "st.slots._id": p.slotId },
          { "sl._id": p.slotId },
        ],
      }
    );
  }
  console.log(`Updated ${plans.length} slots`);
  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

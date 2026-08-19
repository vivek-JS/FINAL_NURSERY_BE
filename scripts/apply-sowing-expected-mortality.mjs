/**
 * Put 10% of diary-sowed plants into expectedMortality (90% actual / 10% reserve).
 *
 *   node scripts/apply-sowing-expected-mortality.mjs
 *   node scripts/apply-sowing-expected-mortality.mjs --apply
 */
import dotenv from "dotenv";
import mongoose from "mongoose";
import path from "path";
import { fileURLToPath } from "url";
import PlantSlot from "../models/slots.model.js";
import SowingRequest from "../models/sowingRequest.model.js";
import { splitLagwadQtyForSlot } from "../utility/lagwadSlotPlantsSplit.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "../.env") });

const APPLY = process.argv.includes("--apply");
const TAG = "diary-sow-2026";
const fmt = (n) => Number(n || 0).toLocaleString("en-IN");

async function main() {
  console.log(APPLY ? "=== APPLY 10% expected mortality on diary sow slots ===" : "=== DRY RUN ===");
  await mongoose.connect(process.env.PROD_MONGO_URL);

  const diary = await SowingRequest.find({ notes: new RegExp(TAG) })
    .select("requestNumber subtypeName sowedQuantity linkedSlotIds")
    .lean();
  const slotIds = [
    ...new Set(diary.flatMap((r) => (r.linkedSlotIds || []).map((id) => String(id)))),
  ];
  console.log(`Diary requests ${diary.length} · slots ${slotIds.length}\n`);

  const docs = await PlantSlot.find({
    "subtypeSlots.slots._id": { $in: slotIds.map((id) => new mongoose.Types.ObjectId(id)) },
  });

  const plans = [];
  let totSowed = 0;
  let totActual = 0;
  let totMort = 0;
  for (const doc of docs) {
    for (const st of doc.subtypeSlots || []) {
      for (const sl of st.slots || []) {
        if (!slotIds.includes(String(sl._id))) continue;
        const sowed = Number(sl.plantsSowed) || 0;
        const actual = Number(sl.actualPlants) || 0;
        const mort = Number(sl.expectedMortality) || 0;
        const avail = Number(sl.availablePlants) || 0;
        const gross = sowed > 0 ? sowed : actual + mort;
        const split = splitLagwadQtyForSlot(gross);
        if (
          split.actualPlants === actual &&
          split.expectedMortality === mort &&
          split.actualPlants === avail
        ) {
          continue;
        }
        totSowed += gross;
        totActual += split.actualPlants;
        totMort += split.expectedMortality;
        plans.push({
          docId: doc._id,
          slotId: sl._id,
          startDay: sl.startDay,
          subtype: st.subtypeName || "",
          sowed: gross,
          from: { actual, mort, avail },
          to: {
            actual: split.actualPlants,
            mort: split.expectedMortality,
            avail: split.actualPlants,
          },
        });
      }
    }
  }

  console.log("Slot".padEnd(24) + "Sowed".padStart(10) + "Actual".padStart(22) + "Mort".padStart(22) + "Avail".padStart(22));
  console.log("-".repeat(100));
  for (const p of plans) {
    console.log(
      String(p.startDay || "").padEnd(24) +
        fmt(p.sowed).padStart(10) +
        `${fmt(p.from.actual)}→${fmt(p.to.actual)}`.padStart(22) +
        `${fmt(p.from.mort)}→${fmt(p.to.mort)}`.padStart(22) +
        `${fmt(p.from.avail)}→${fmt(p.to.avail)}`.padStart(22)
    );
  }
  console.log("-".repeat(100));
  console.log(`Slots ${plans.length} · sowed ${fmt(totSowed)} · actual 90% ${fmt(totActual)} · mort 10% ${fmt(totMort)}`);

  if (!APPLY) {
    console.log("\nRe-run with --apply to write PROD.");
    await mongoose.disconnect();
    return;
  }

  for (const p of plans) {
    await PlantSlot.updateOne(
      { _id: p.docId, "subtypeSlots.slots._id": p.slotId },
      {
        $set: {
          "subtypeSlots.$[st].slots.$[sl].actualPlants": p.to.actual,
          "subtypeSlots.$[st].slots.$[sl].expectedMortality": p.to.mort,
          "subtypeSlots.$[st].slots.$[sl].availablePlants": p.to.avail,
          "subtypeSlots.$[st].slots.$[sl].availablePlantsMaterialized": true,
        },
      },
      { arrayFilters: [{ "st.slots._id": p.slotId }, { "sl._id": p.slotId }] }
    );
  }
  console.log(`Updated ${plans.length} slots`);
  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

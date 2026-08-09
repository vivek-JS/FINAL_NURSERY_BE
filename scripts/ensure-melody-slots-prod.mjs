/**
 * Melody: align CMS slot config + clone day-slot calendar from SImbha (2026 + 2027).
 *
 *   node scripts/ensure-melody-slots-prod.mjs           # dry-run PROD
 *   node scripts/ensure-melody-slots-prod.mjs --apply   # write PROD
 */
import dotenv from "dotenv";
import mongoose from "mongoose";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "../.env") });

const APPLY = process.argv.includes("--apply");
const PLANT_ID = "691054dffba6fb380f8d57b3";
const YEARS = [2026, 2027];
const MELODY_NORM = "melody";
const TEMPLATE_NORM = "simbha";

const norm = (s) =>
  String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");

function uri() {
  const url = process.env.PROD_MONGO_URL;
  if (!url) throw new Error("PROD_MONGO_URL missing");
  return url;
}

function subtypeReadyDays(subtype) {
  const n = Number(subtype?.plantReadyDays);
  return Number.isFinite(n) && n > 0 ? n : 18;
}

function emptySlotFromTemplate(src, readyDays) {
  return {
    _id: new mongoose.Types.ObjectId(),
    startDay: src.startDay,
    endDay: src.endDay || src.startDay,
    month: src.month || "",
    year: src.year || undefined,
    totalPlants: 0,
    totalBookedPlants: 0,
    availablePlants: 0,
    buffer: Number(src.buffer) || 0,
    effectiveBuffer: Number(src.effectiveBuffer) || 0,
    bufferAdjustedCapacity: Number(src.bufferAdjustedCapacity) || 0,
    bufferAmount: Number(src.bufferAmount) || 0,
    originalTotalPlants: 0,
    isOverflow: false,
    orders: [],
    allowedSalesmen: [],
    restrictToSalesmen: false,
    overflow: [],
    status: src.status ?? true,
    isManual: true,
    plantReadyDays: readyDays || Number(src.plantReadyDays) || 0,
    plantsSowed: 0,
    primarySowed: 0,
    officeSowed: 0,
    sowingDate: "",
    plantReadyDate: "",
    reminderBeforePlantReadyDays: Number(src.reminderBeforePlantReadyDays) || 0,
    sowingBatches: [],
    linkedSowingRequests: [],
    sowingInProgress: [],
    excessiveSowing: { packets: 0, plants: 0 },
  };
}

async function ensureCalendar(db, plantId, year, melody, templateId) {
  const readyDays = subtypeReadyDays(melody);
  const doc = await db.collection("plantslots").findOne({ plantId, year });
  if (!doc) throw new Error(`plantslots missing year ${year}`);

  const tmplSt = (doc.subtypeSlots || []).find(
    (s) => String(s.subtypeId) === String(templateId)
  );
  if (!tmplSt?.slots?.length) {
    throw new Error(`SImbha has no slots in year ${year}`);
  }

  let targetSt = (doc.subtypeSlots || []).find(
    (s) => String(s.subtypeId) === String(melody._id)
  );

  if (!targetSt) {
    console.log(`  ${year} Melody: no subtypeSlots — ${APPLY ? "creating" : "would create"}`);
    if (APPLY) {
      await db.collection("plantslots").updateOne(
        { _id: doc._id },
        {
          $push: {
            subtypeSlots: {
              subtypeId: new mongoose.Types.ObjectId(melody._id),
              slots: [],
            },
          },
        }
      );
    }
    targetSt = { subtypeId: melody._id, slots: [] };
  }

  const have = new Set((targetSt.slots || []).map((s) => String(s.startDay || "")));
  const toAdd = [];
  for (const src of tmplSt.slots) {
    const day = String(src.startDay || "");
    if (!day || have.has(day)) continue;
    toAdd.push(emptySlotFromTemplate(src, readyDays));
  }

  if (!toAdd.length) {
    console.log(
      `  ${year} Melody: complete (${(targetSt.slots || []).length} slots, template ${tmplSt.slots.length})`
    );
    return { added: 0 };
  }

  console.log(
    `  ${year} Melody: ${APPLY ? "adding" : "would add"} ${toAdd.length} slots (have ${(targetSt.slots || []).length})`
  );

  if (APPLY) {
    await db.collection("plantslots").updateOne(
      {
        _id: doc._id,
        "subtypeSlots.subtypeId": new mongoose.Types.ObjectId(melody._id),
      },
      { $push: { "subtypeSlots.$.slots": { $each: toAdd } } }
    );
  }
  return { added: toAdd.length };
}

async function alignMelodyCms(db, plant, melody, template) {
  const set = {
    slotDays: template.slotDays ?? 1,
    slotStartDate: template.slotStartDate || "01-01-2026",
    slotEndDate: template.slotEndDate || "31-12-2027",
    slotCapacity: template.slotCapacity ?? 1,
    buffer: template.buffer ?? 0,
    dailyDispatch: template.dailyDispatch ?? 0,
  };
  console.log(
    `  CMS Melody: ${APPLY ? "align" : "would align"} slotDays ${melody.slotDays}→${set.slotDays}, dates ${melody.slotStartDate}→${set.slotStartDate}`
  );
  if (APPLY) {
    await db.collection("plantcms").updateOne(
      { _id: plant._id, "subtypes._id": melody._id },
      {
        $set: {
          "subtypes.$.slotDays": set.slotDays,
          "subtypes.$.slotStartDate": set.slotStartDate,
          "subtypes.$.slotEndDate": set.slotEndDate,
          "subtypes.$.slotCapacity": set.slotCapacity,
          "subtypes.$.buffer": set.buffer,
          "subtypes.$.dailyDispatch": set.dailyDispatch,
        },
      }
    );
  }
}

async function main() {
  console.log(APPLY ? "APPLY PROD" : "DRY-RUN PROD — pass --apply to write\n");

  await mongoose.connect(uri(), { serverSelectionTimeoutMS: 25000 });
  const db = mongoose.connection.db;
  const plantId = new mongoose.Types.ObjectId(PLANT_ID);

  const plant = await db.collection("plantcms").findOne(
    { _id: plantId },
    { projection: { name: 1, subtypes: 1 } }
  );
  const template = (plant.subtypes || []).find(
    (s) => norm(s.name) === TEMPLATE_NORM || norm(s.name).includes("simbha")
  );
  const melody = (plant.subtypes || []).find((s) => norm(s.name) === MELODY_NORM);
  if (!template) throw new Error("SImbha template missing");
  if (!melody) throw new Error("Melody subtype missing");

  console.log(`Template: ${template.name}`);
  console.log(`Target: ${melody.name} (${melody._id})\n`);

  console.log("Align CMS…");
  await alignMelodyCms(db, plant, melody, template);

  console.log("\nEnsure plantslots…");
  for (const year of YEARS) {
    await ensureCalendar(db, plantId, year, melody, template._id);
  }

  console.log("\nVerify:");
  for (const year of YEARS) {
    const doc = await db.collection("plantslots").findOne({ plantId, year });
    const entry = (doc?.subtypeSlots || []).find(
      (s) => String(s.subtypeId) === String(melody._id)
    );
    console.log(`  ${year} Melody: ${entry?.slots?.length || 0} slots`);
  }

  await mongoose.disconnect();
  console.log(APPLY ? "\nDone." : "\nDry-run complete.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

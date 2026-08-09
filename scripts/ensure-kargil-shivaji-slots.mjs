/**
 * Ensure Watermelon "Kargil Plus" / "Karlgil Plus" / "Shivaji" have the same
 * day-slot calendar as a full template subtype (SImbha → 365 days/year).
 *
 * Does NOT overwrite existing slots; only adds missing startDay keys and
 * creates missing subtypeSlots entries.
 *
 * Usage:
 *   node scripts/ensure-kargil-shivaji-slots.mjs           # dry-run
 *   node scripts/ensure-kargil-shivaji-slots.mjs --apply   # write PROD
 *   node scripts/ensure-kargil-shivaji-slots.mjs --apply --stage
 */
import dotenv from "dotenv";
import mongoose from "mongoose";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "../.env") });

const APPLY = process.argv.includes("--apply");
const USE_STAGE = process.argv.includes("--stage");
const PLANT_ID = "691054dffba6fb380f8d57b3";
const YEARS = [2026, 2027];
const TEMPLATE_NAME = "simbha"; // SImbha / Simba

const TARGET_NORM = new Set(["kargilplus", "karlgilplus", "shivaji"]);

const norm = (s) =>
  String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");

function uri() {
  const url = USE_STAGE
    ? process.env.STAGE_MONGO_URL || process.env.MONGO_URL
    : process.env.PROD_MONGO_URL;
  if (!url) throw new Error(USE_STAGE ? "STAGE/MONGO_URL missing" : "PROD_MONGO_URL missing");
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
    reminderBeforePlantReadyDays:
      Number(src.reminderBeforePlantReadyDays) || 0,
    sowingBatches: [],
    linkedSowingRequests: [],
    sowingInProgress: [],
    excessiveSowing: { packets: 0, plants: 0 },
  };
}

async function ensureCalendar(db, plantId, year, subtype, templateSubtypeId) {
  const readyDays = subtypeReadyDays(subtype);
  const doc = await db.collection("plantslots").findOne({ plantId, year });
  if (!doc) {
    throw new Error(`plantslots missing for watermelon year ${year}`);
  }

  const tmplSt = (doc.subtypeSlots || []).find(
    (s) => String(s.subtypeId) === String(templateSubtypeId)
  );
  if (!tmplSt?.slots?.length) {
    throw new Error(
      `template subtype ${templateSubtypeId} has no slots in year ${year}`
    );
  }

  let targetSt = (doc.subtypeSlots || []).find(
    (s) => String(s.subtypeId) === String(subtype._id)
  );

  if (!targetSt) {
    console.log(
      `  ${year} ${subtype.name}: no subtypeSlots entry — will create`
    );
    if (APPLY) {
      await db.collection("plantslots").updateOne(
        { _id: doc._id },
        {
          $push: {
            subtypeSlots: {
              subtypeId: new mongoose.Types.ObjectId(subtype._id),
              slots: [],
            },
          },
        }
      );
    }
    targetSt = { subtypeId: subtype._id, slots: [] };
  }

  const have = new Set(
    (targetSt.slots || []).map((s) => String(s.startDay || ""))
  );
  const toAdd = [];
  for (const src of tmplSt.slots) {
    const day = String(src.startDay || "");
    if (!day || have.has(day)) continue;
    toAdd.push(emptySlotFromTemplate(src, readyDays));
    have.add(day);
  }

  if (!toAdd.length) {
    console.log(
      `  ${year} ${subtype.name}: already complete (${(targetSt.slots || []).length} slots)`
    );
    return { added: 0, total: (targetSt.slots || []).length };
  }

  console.log(
    `  ${year} ${subtype.name}: ${APPLY ? "adding" : "would add"} ${toAdd.length} day-slots (have ${(targetSt.slots || []).length}, template ${tmplSt.slots.length})`
  );

  if (APPLY) {
    await db.collection("plantslots").updateOne(
      {
        _id: doc._id,
        "subtypeSlots.subtypeId": new mongoose.Types.ObjectId(subtype._id),
      },
      { $push: { "subtypeSlots.$.slots": { $each: toAdd } } }
    );
  }

  return {
    added: toAdd.length,
    total: (targetSt.slots || []).length + toAdd.length,
  };
}

/** Align CMS slot calendar fields with template so UI/regen matches peers. */
async function alignCmsSlotFields(db, plant, targets, template) {
  const set = {
    slotDays: template.slotDays ?? 1,
    slotStartDate: template.slotStartDate || "01-01-2026",
    slotEndDate: template.slotEndDate || "31-12-2027",
    slotCapacity: template.slotCapacity ?? 1,
    buffer: template.buffer ?? 0,
    dailyDispatch: template.dailyDispatch ?? 0,
  };
  for (const st of targets) {
    const needs =
      Number(st.slotDays) !== Number(set.slotDays) ||
      String(st.slotStartDate) !== String(set.slotStartDate) ||
      String(st.slotEndDate) !== String(set.slotEndDate) ||
      Number(st.slotCapacity) !== Number(set.slotCapacity);
    if (!needs) {
      console.log(`  CMS ${st.name} (${st._id}): slot fields already aligned`);
      continue;
    }
    console.log(
      `  CMS ${st.name} (${st._id}): ${APPLY ? "align" : "would align"} slotDays/start/end/capacity → like ${template.name}`
    );
    if (APPLY) {
      await db.collection("plantcms").updateOne(
        { _id: plant._id, "subtypes._id": st._id },
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
}

async function main() {
  console.log(
    APPLY
      ? `APPLY — writing ${USE_STAGE ? "STAGE" : "PROD"}`
      : `DRY-RUN (${USE_STAGE ? "STAGE" : "PROD"}) — pass --apply to write`
  );

  await mongoose.connect(uri(), { serverSelectionTimeoutMS: 25000 });
  const db = mongoose.connection.db;
  const plantId = new mongoose.Types.ObjectId(PLANT_ID);

  const plant = await db.collection("plantcms").findOne(
    { _id: plantId },
    { projection: { name: 1, subtypes: 1 } }
  );
  if (!plant) throw new Error("Watermelon PlantCms missing");

  const template = (plant.subtypes || []).find(
    (s) => norm(s.name) === TEMPLATE_NAME || norm(s.name).includes("simbha")
  );
  if (!template) throw new Error("SImbha template subtype missing");
  console.log(`Template: ${template.name} (${template._id})`);

  const targets = (plant.subtypes || []).filter((s) =>
    TARGET_NORM.has(norm(s.name))
  );
  if (!targets.length) throw new Error("No Kargil/Shivaji subtypes found");

  console.log(
    "Targets:",
    targets.map((s) => `${s.name}(${s._id})`).join(", ")
  );

  console.log("\nAlign CMS slot fields…");
  await alignCmsSlotFields(db, plant, targets, template);

  console.log("\nEnsure plantslots calendars…");
  for (const year of YEARS) {
    for (const st of targets) {
      await ensureCalendar(db, plantId, year, st, template._id);
    }
  }

  // Verify
  console.log("\nVerify:");
  for (const year of YEARS) {
    const doc = await db.collection("plantslots").findOne({ plantId, year });
    for (const st of targets) {
      const entry = (doc?.subtypeSlots || []).find(
        (s) => String(s.subtypeId) === String(st._id)
      );
      console.log(
        `  ${year} ${st.name}: ${entry ? `${entry.slots?.length || 0} slots` : "NO ENTRY"}`
      );
    }
  }

  await mongoose.disconnect();
  console.log(APPLY ? "\nDone." : "\nDry-run complete. Re-run with --apply to write.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

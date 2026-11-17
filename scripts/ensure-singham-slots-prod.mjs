/**
 * Watermelon "Singham" (Sagar Biotech, 6a48d529…) only has 3 day-slots.
 * Give it the same 1-day calendar as SImbha for 2026 and 2027.
 *
 * The older auto-created Singham (6947cce6…) already has 365 days/year and
 * is left untouched. Existing days on the Sagar subtype are never overwritten.
 *
 *   node scripts/ensure-singham-slots-prod.mjs           # dry-run PROD
 *   node scripts/ensure-singham-slots-prod.mjs --apply   # write PROD
 */
import dotenv from "dotenv";
import fs from "fs";
import mongoose from "mongoose";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "../.env") });

const APPLY = process.argv.includes("--apply");
const PLANT_ID = "691054dffba6fb380f8d57b3";
const SINGHAM_ID = "6a48d529b9541a2d76afb651";
const YEARS = [2026, 2027];
const TEMPLATE_NORM = "simbha";
const RANGE_START = "01-01-2026";
const RANGE_END = "31-12-2027";

const norm = (s) =>
  String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");

function uri() {
  const url = process.env.PROD_MONGO_URL;
  if (!url) throw new Error("PROD_MONGO_URL missing");
  return url;
}

function emptyDaySlot(src, subtype) {
  const cap = Math.max(0, Number(subtype.slotCapacity) || 0);
  const readyDays = Math.max(0, Number(subtype.plantReadyDays) || 0);
  return {
    _id: new mongoose.Types.ObjectId(),
    excessiveSowing: { packets: 0, plants: 0 },
    rolledInActualReadyPlants: 0,
    orderReservedPlants: 0,
    rolledInAvailablePlants: 0,
    availablePlantsMaterialized: false,
    actualPlants: 0,
    closingStock: 0,
    startDay: src.startDay,
    endDay: src.endDay || src.startDay,
    totalPlants: cap,
    totalBookedPlants: 0,
    availablePlants: cap,
    buffer: Number(subtype.buffer) || 0,
    effectiveBuffer: 0,
    bufferAdjustedCapacity: cap,
    bufferAmount: 0,
    originalTotalPlants: cap,
    isOverflow: false,
    orders: [],
    allowedSalesmen: [],
    restrictToSalesmen: false,
    overflow: false,
    status: true,
    month: src.month || "",
    isManual: false,
    plantReadyDays: readyDays,
    plantsSowed: 0,
    officeSowed: 0,
    primarySowed: 0,
    sowingDate: null,
    plantReadyDate: null,
    reminderBeforePlantReadyDays: 0,
    sowingCompleted: false,
    linkedSowingRequests: [],
    gapFullyCovered: false,
    sowingInProgress: [],
    gapCovered: [],
    productStock: [],
    slotTrail: [],
    actualReadyPlants: 0,
    expectedMortality: 0,
    lagwadRemaining: 0,
    sowingBatches: [],
  };
}

async function ensureCalendar(db, plantId, year, singham, templateId) {
  const doc = await db.collection("plantslots").findOne({ plantId, year });
  if (!doc) throw new Error(`plantslots missing for watermelon year ${year}`);

  const tmplSt = (doc.subtypeSlots || []).find(
    (s) => String(s.subtypeId) === String(templateId)
  );
  if (!tmplSt?.slots?.length) {
    throw new Error(`SImbha has no slots in year ${year}`);
  }

  let targetSt = (doc.subtypeSlots || []).find(
    (s) => String(s.subtypeId) === String(singham._id)
  );

  if (!targetSt) {
    console.log(`  ${year}: no subtypeSlots entry — ${APPLY ? "creating" : "would create"}`);
    if (APPLY) {
      await db.collection("plantslots").updateOne(
        { _id: doc._id },
        {
          $push: {
            subtypeSlots: {
              subtypeId: new mongoose.Types.ObjectId(singham._id),
              slots: [],
            },
          },
        }
      );
    }
    targetSt = { subtypeId: singham._id, slots: [] };
  }

  const have = new Set((targetSt.slots || []).map((s) => String(s.startDay || "")));
  const toAdd = [];
  for (const src of tmplSt.slots) {
    const day = String(src.startDay || "");
    if (!day || have.has(day)) continue;
    toAdd.push(emptyDaySlot(src, singham));
    have.add(day);
  }

  if (!toAdd.length) {
    console.log(`  ${year}: already complete (${(targetSt.slots || []).length} slots)`);
    return { added: 0 };
  }

  console.log(
    `  ${year}: ${APPLY ? "adding" : "would add"} ${toAdd.length} day-slots (have ${(targetSt.slots || []).length}, template ${tmplSt.slots.length}, capacity ${singham.slotCapacity})`
  );
  console.log(`  kept days: ${[...(targetSt.slots || []).map((s) => s.startDay)].join(", ") || "none"}`);

  if (APPLY) {
    await db.collection("plantslots").updateOne(
      {
        _id: doc._id,
        "subtypeSlots.subtypeId": new mongoose.Types.ObjectId(singham._id),
      },
      { $push: { "subtypeSlots.$.slots": { $each: toAdd } } }
    );
  }
  return { added: toAdd.length };
}

async function alignCms(db, plant, singham) {
  const set = {
    slotDays: 1,
    slotStartDate: RANGE_START,
    slotEndDate: RANGE_END,
  };
  const needs =
    Number(singham.slotDays) !== 1 ||
    String(singham.slotStartDate) !== RANGE_START ||
    String(singham.slotEndDate) !== RANGE_END;
  if (!needs) {
    console.log("  CMS dates already 01-01-2026 → 31-12-2027");
    return;
  }
  console.log(
    `  CMS: ${APPLY ? "align" : "would align"} slotDays ${singham.slotDays}→1, ${singham.slotStartDate}→${RANGE_START}, ${singham.slotEndDate}→${RANGE_END} (capacity stays ${singham.slotCapacity})`
  );
  if (APPLY) {
    await db.collection("plantcms").updateOne(
      { _id: plant._id, "subtypes._id": singham._id },
      {
        $set: {
          "subtypes.$.slotDays": set.slotDays,
          "subtypes.$.slotStartDate": set.slotStartDate,
          "subtypes.$.slotEndDate": set.slotEndDate,
        },
      }
    );
  }
}

async function backup(db, plantId, singham) {
  const snap = { at: new Date().toISOString(), cms: singham, years: {} };
  for (const year of YEARS) {
    const doc = await db.collection("plantslots").findOne({ plantId, year });
    const entry = (doc?.subtypeSlots || []).find(
      (s) => String(s.subtypeId) === String(singham._id)
    );
    snap.years[year] = {
      docId: doc?._id ? String(doc._id) : null,
      days: (entry?.slots || []).map((s) => ({
        _id: String(s._id),
        startDay: s.startDay,
        endDay: s.endDay,
        totalPlants: s.totalPlants,
        totalBookedPlants: s.totalBookedPlants,
        orders: (s.orders || []).length,
      })),
    };
  }
  const file = path.join(__dirname, `../../dryrun-reports/backup-singham-slots-${Date.now()}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(snap, null, 1));
  console.log("Backup:", file);
}

async function main() {
  console.log(APPLY ? "APPLY PROD\n" : "DRY-RUN PROD — pass --apply to write\n");
  await mongoose.connect(uri(), { serverSelectionTimeoutMS: 25000 });
  const db = mongoose.connection.db;
  const plantId = new mongoose.Types.ObjectId(PLANT_ID);

  const plant = await db.collection("plantcms").findOne(
    { _id: plantId },
    { projection: { name: 1, subtypes: 1 } }
  );
  if (!plant) throw new Error("Watermelon PlantCms missing");

  const template = (plant.subtypes || []).find(
    (s) => norm(s.name) === TEMPLATE_NORM || norm(s.name).includes("simbha")
  );
  const singham = (plant.subtypes || []).find((s) => String(s._id) === SINGHAM_ID);
  if (!template) throw new Error("SImbha template missing");
  if (!singham || norm(singham.name) !== "singham") {
    throw new Error("Sagar Biotech Singham subtype missing");
  }

  console.log(`Template: ${template.name}`);
  console.log(`Target: ${singham.name} (${singham._id}) ${singham.description || ""}\n`);

  if (APPLY) await backup(db, plantId, singham);

  console.log("Align CMS…");
  await alignCms(db, plant, singham);

  console.log("\nEnsure plantslots…");
  for (const year of YEARS) {
    await ensureCalendar(db, plantId, year, singham, template._id);
  }

  console.log("\nVerify:");
  for (const year of YEARS) {
    const doc = await db.collection("plantslots").findOne({ plantId, year });
    const entry = (doc?.subtypeSlots || []).find(
      (s) => String(s.subtypeId) === String(singham._id)
    );
    const days = (entry?.slots || [])
      .map((s) => s.startDay)
      .filter(Boolean)
      .sort((a, b) => {
        const [da, ma, ya] = String(a).split("-").map(Number);
        const [db, mb, yb] = String(b).split("-").map(Number);
        return new Date(ya, ma - 1, da) - new Date(yb, mb - 1, db);
      });
    console.log(
      `  ${year}: ${entry?.slots?.length || 0} slots (${days[0] || "—"} → ${days[days.length - 1] || "—"})`
    );
  }

  await mongoose.disconnect();
  console.log(APPLY ? "\nDone." : "\nDry-run complete.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

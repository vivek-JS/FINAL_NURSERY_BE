/**
 * Chili "Gauri": extend the 7-day slot calendar through 31-12-2027,
 * matching Bholi / Rajnandani (month-clipped weeks, capacity 100000,
 * plantReadyDays 35).
 *
 * Existing October 2026 slots (15-10, 22-10, 29-10) are left untouched.
 * Missing weeks are copied from Bholi's date windows, starting 01-11-2026.
 *
 *   node scripts/ensure-gauri-chili-slots.mjs                          # dry-run
 *   CONFIRM_PROD=YES node scripts/ensure-gauri-chili-slots.mjs --apply # write PROD
 */
import dotenv from "dotenv";
import mongoose from "mongoose";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import moment from "moment";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "../.env") });

const APPLY = process.argv.includes("--apply");
if (APPLY && process.env.CONFIRM_PROD !== "YES") {
  console.error("Refusing to write PROD without CONFIRM_PROD=YES");
  process.exit(1);
}

const PLANT_ID = new mongoose.Types.ObjectId("69ca55e39a0e4732b63e96b9");
const GAURI_ID = new mongoose.Types.ObjectId("6ab79702c0c07b26fe4fb5e9");
const TEMPLATE_ID = new mongoose.Types.ObjectId("6acf4cb002452a2fc547803e"); // Bholi
const YEARS = [2026, 2027];
const FROM = moment("01-11-2026", "DD-MM-YYYY");
const UNTIL = moment("31-12-2027", "DD-MM-YYYY");
const SLOT_END = "2027-12-31";
const CAP = 100000;
const READY_DAYS = 35;

function day(value) {
  const parsed = moment(String(value || ""), "DD-MM-YYYY", true);
  return parsed.isValid() ? parsed : null;
}

function emptySlot(src) {
  return {
    _id: new mongoose.Types.ObjectId(),
    excessiveSowing: { packets: 0, plants: 0 },
    startDay: src.startDay,
    endDay: src.endDay,
    totalPlants: CAP,
    totalBookedPlants: 0,
    availablePlants: CAP,
    availablePlantsMaterialized: false,
    actualPlants: 0,
    expectedMortality: 0,
    actualReadyPlants: 0,
    lagwadRemaining: 0,
    rolledInAvailablePlants: 0,
    rolledInActualReadyPlants: 0,
    closingStock: 0,
    buffer: 0,
    effectiveBuffer: 0,
    bufferAdjustedCapacity: 0,
    bufferAmount: 0,
    originalTotalPlants: 0,
    isOverflow: false,
    orders: [],
    allowedSalesmen: [],
    restrictToSalesmen: false,
    overflow: false,
    status: true,
    month: src.month || "",
    isManual: false,
    plantReadyDays: READY_DAYS,
    plantsSowed: 0,
    officeSowed: 0,
    primarySowed: 0,
    reminderBeforePlantReadyDays: 0,
    orderReservedPlants: 0,
    sowingCompleted: false,
    linkedSowingRequests: [],
    gapFullyCovered: false,
    sowingInProgress: [],
    sowingBatches: [],
    gapCovered: [],
    productStock: [],
    slotTrail: [],
  };
}

async function main() {
  console.log(APPLY ? "=== APPLY (PROD) ===" : "=== DRY RUN (PROD) ===");
  await mongoose.connect(process.env.PROD_MONGO_URL, {
    serverSelectionTimeoutMS: 25000,
  });
  const db = mongoose.connection.db;
  const plants = db.collection("plantcms");
  const slotsCol = db.collection("plantslots");

  const plant = await plants.findOne({ _id: PLANT_ID });
  const gauri = (plant?.subtypes || []).find(
    (s) => String(s._id) === String(GAURI_ID)
  );
  if (!gauri || gauri.name !== "Gauri") {
    throw new Error("Chili Gauri subtype not found");
  }
  if (Number(gauri.slotDays) !== 7) {
    throw new Error(`Gauri slotDays is ${gauri.slotDays}, expected 7`);
  }

  const backup = { at: new Date().toISOString(), cms: gauri, years: {} };
  for (const year of YEARS) {
    const doc = await slotsCol.findOne({ plantId: PLANT_ID, year });
    backup.years[year] = {
      docId: doc?._id || null,
      entry:
        (doc?.subtypeSlots || []).find(
          (s) => String(s.subtypeId) === String(GAURI_ID)
        ) || null,
    };
  }
  if (APPLY) {
    const backupFile = path.join(
      __dirname,
      `../../dryrun-reports/backup-gauri-chili-slots-${Date.now()}.json`
    );
    fs.mkdirSync(path.dirname(backupFile), { recursive: true });
    fs.writeFileSync(backupFile, JSON.stringify(backup, null, 1));
    console.log("Backup:", backupFile);
  }

  if (String(gauri.slotEndDate) !== SLOT_END) {
    console.log(
      `CMS Gauri slotEndDate ${gauri.slotEndDate} → ${SLOT_END} (slotDays stays 7, capacity stays ${gauri.slotCapacity})`
    );
    if (APPLY) {
      await plants.updateOne(
        { _id: PLANT_ID, "subtypes._id": GAURI_ID },
        { $set: { "subtypes.$.slotEndDate": SLOT_END } }
      );
    }
  } else {
    console.log("CMS Gauri slotEndDate already", SLOT_END);
  }

  for (const year of YEARS) {
    const doc = await slotsCol.findOne({ plantId: PLANT_ID, year });
    if (!doc) throw new Error(`plantslots missing for Chili ${year}`);

    const template = (doc.subtypeSlots || []).find(
      (s) => String(s.subtypeId) === String(TEMPLATE_ID)
    );
    if (!template?.slots?.length) {
      throw new Error(`Bholi has no slots in ${year}`);
    }

    let entry = (doc.subtypeSlots || []).find(
      (s) => String(s.subtypeId) === String(GAURI_ID)
    );
    if (!entry) {
      console.log(`${year}: no Gauri entry — creating`);
      if (APPLY) {
        await slotsCol.updateOne(
          { _id: doc._id },
          { $push: { subtypeSlots: { subtypeId: GAURI_ID, slots: [] } } }
        );
      }
      entry = { subtypeId: GAURI_ID, slots: [] };
    }

    const have = new Set((entry.slots || []).map((s) => String(s.startDay)));
    const toAdd = [];
    for (const src of template.slots) {
      const start = day(src.startDay);
      if (!start || start.isBefore(FROM, "day") || start.isAfter(UNTIL, "day")) {
        continue;
      }
      if (have.has(String(src.startDay))) continue;
      toAdd.push(emptySlot(src));
      have.add(String(src.startDay));
    }

    const first = toAdd[0]?.startDay;
    const last = toAdd[toAdd.length - 1]?.endDay;
    if (!toAdd.length) {
      console.log(
        `${year}: already complete (${(entry.slots || []).length} slots)`
      );
      continue;
    }
    console.log(
      `${year}: ${APPLY ? "adding" : "would add"} ${toAdd.length} slots ${first} → ${last} (have ${(entry.slots || []).length})`
    );
    if (APPLY) {
      await slotsCol.updateOne(
        { _id: doc._id, "subtypeSlots.subtypeId": GAURI_ID },
        { $push: { "subtypeSlots.$.slots": { $each: toAdd } } }
      );
    }
  }

  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error(err);
  try {
    await mongoose.disconnect();
  } catch {
    /* ignore */
  }
  process.exit(1);
});

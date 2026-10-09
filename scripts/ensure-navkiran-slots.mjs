/**
 * Give Watermelon "Navkiran" the same day-slot calendar as the other watermelon
 * varieties (1-day slots, 01-01-2026 → 31-12-2027), using "Tarzan" as the
 * capacity-100000 template (Navkiran already has slotCapacity 100000).
 *
 * - CMS: slotDays 1, 01-01-2026..31-12-2027, buffer like peers (12). Capacity kept.
 * - 2026: the single 5-day slot 11→15 Oct carries real sowing (SR202609300005,
 *   ready date 14-10-2026). It is KEPT (same _id, same sowing data) and only
 *   re-dated to the single day 14-10-2026. All other days get empty day-slots.
 * - 2027: creates the subtypeSlots entry with the full year.
 * - Never overwrites existing days; idempotent. Targeted updates only.
 *
 *   node scripts/ensure-navkiran-slots.mjs                          # dry-run
 *   CONFIRM_PROD=YES node scripts/ensure-navkiran-slots.mjs --apply # write PROD
 */
import dotenv from "dotenv";
import mongoose from "mongoose";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "../.env") });

const APPLY = process.argv.includes("--apply");
if (APPLY && process.env.CONFIRM_PROD !== "YES") {
  console.error("Refusing to write PROD without CONFIRM_PROD=YES");
  process.exit(1);
}

const OID = (s) => new mongoose.Types.ObjectId(String(s));
const PLANT_ID = OID("691054dffba6fb380f8d57b3");
const NAV_ID = OID("6aba0066db0e7e57ee1c5edf");
const TEMPLATE_ID = OID("6947cce0d688df310a94bb00"); // Tarzan (cap 100000)
const YEARS = [2026, 2027];
const SOWN_SLOT_ID = "6aba006adb0e7e57ee1c7fd6";
const SOWN_DAY = "14-10-2026"; // plant ready date of the sown batch
const CAP = 100000;
const PEER_BUFFER = 12;

function emptyDaySlot(src) {
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
    totalPlants: CAP,
    totalBookedPlants: 0,
    availablePlants: CAP,
    buffer: 0,
    effectiveBuffer: 0,
    bufferAdjustedCapacity: CAP,
    bufferAmount: 0,
    originalTotalPlants: CAP,
    isOverflow: false,
    orders: [],
    allowedSalesmen: [],
    restrictToSalesmen: false,
    overflow: false,
    status: true,
    month: src.month || "",
    isManual: false,
    plantReadyDays: 18,
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
    ...(src.year ? { year: src.year } : {}),
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
  const nav = plant.subtypes.find((s) => String(s._id) === String(NAV_ID));
  if (!nav || nav.name !== "Navkiran") throw new Error("Navkiran subtype not found");

  // backup
  const backup = { at: new Date().toISOString(), cms: nav, years: {} };
  for (const y of YEARS) {
    const d = await slotsCol.findOne({ plantId: PLANT_ID, year: y });
    backup.years[y] = {
      docId: d?._id,
      entry: (d?.subtypeSlots || []).find((s) => String(s.subtypeId) === String(NAV_ID)) || null,
    };
  }
  const backupFile = path.join(
    __dirname,
    `../../dryrun-reports/backup-navkiran-slots-${Date.now()}.json`
  );
  if (APPLY) {
    fs.mkdirSync(path.dirname(backupFile), { recursive: true });
    fs.writeFileSync(backupFile, JSON.stringify(backup, null, 1));
    console.log("Backup:", backupFile);
  }

  // CMS fields
  const cmsSet = {
    "subtypes.$.slotDays": 1,
    "subtypes.$.slotStartDate": "01-01-2026",
    "subtypes.$.slotEndDate": "31-12-2027",
    "subtypes.$.buffer": PEER_BUFFER,
  };
  console.log(
    `CMS Navkiran: slotDays ${nav.slotDays}→1, ${nav.slotStartDate}..${nav.slotEndDate} → 01-01-2026..31-12-2027, buffer ${nav.buffer}→${PEER_BUFFER}, capacity stays ${nav.slotCapacity}`
  );
  if (APPLY) {
    await plants.updateOne({ _id: PLANT_ID, "subtypes._id": NAV_ID }, { $set: cmsSet });
  }

  for (const year of YEARS) {
    const doc = await slotsCol.findOne({ plantId: PLANT_ID, year });
    if (!doc) throw new Error(`plantslots missing for ${year}`);
    const tmpl = doc.subtypeSlots.find((s) => String(s.subtypeId) === String(TEMPLATE_ID));
    if (!tmpl?.slots?.length) throw new Error(`template has no slots in ${year}`);

    let entry = doc.subtypeSlots.find((s) => String(s.subtypeId) === String(NAV_ID));
    if (!entry) {
      console.log(`${year}: no Navkiran entry — creating`);
      if (APPLY) {
        await slotsCol.updateOne(
          { _id: doc._id },
          { $push: { subtypeSlots: { subtypeId: NAV_ID, slots: [] } } }
        );
      }
      entry = { slots: [] };
    }

    // re-date the sown multi-day slot to its ready day (keeps _id + sowing data)
    const sown = (entry.slots || []).find((s) => String(s._id) === SOWN_SLOT_ID);
    if (year === 2026 && sown && (sown.startDay !== SOWN_DAY || sown.endDay !== SOWN_DAY)) {
      console.log(
        `${year}: sown slot ${SOWN_SLOT_ID} ${sown.startDay}→${sown.endDay}  becomes single day ${SOWN_DAY} (plantsSowed ${sown.plantsSowed} kept)`
      );
      if (APPLY) {
        await slotsCol.updateOne(
          { _id: doc._id },
          { $set: { "subtypeSlots.$[st].slots.$[sl].startDay": SOWN_DAY, "subtypeSlots.$[st].slots.$[sl].endDay": SOWN_DAY } },
          { arrayFilters: [{ "st.subtypeId": NAV_ID }, { "sl._id": sown._id }] }
        );
      }
    }

    const have = new Set(
      (entry.slots || []).map((s) =>
        year === 2026 && String(s._id) === SOWN_SLOT_ID ? SOWN_DAY : s.startDay
      )
    );
    const toAdd = [];
    for (const src of tmpl.slots) {
      if (!src.startDay || have.has(src.startDay)) continue;
      toAdd.push(emptyDaySlot(src));
      have.add(src.startDay);
    }
    console.log(
      `${year}: have ${(entry.slots || []).length}, template ${tmpl.slots.length}, ${APPLY ? "adding" : "would add"} ${toAdd.length} day-slots`
    );
    if (APPLY && toAdd.length) {
      await slotsCol.updateOne(
        { _id: doc._id, "subtypeSlots.subtypeId": NAV_ID },
        { $push: { "subtypeSlots.$.slots": { $each: toAdd } } }
      );
    }
  }

  console.log("\nVerify:");
  for (const year of YEARS) {
    const doc = await slotsCol.findOne({ plantId: PLANT_ID, year });
    const e = doc.subtypeSlots.find((s) => String(s.subtypeId) === String(NAV_ID));
    const t = doc.subtypeSlots.find((s) => String(s.subtypeId) === String(TEMPLATE_ID));
    const days = new Set((e?.slots || []).map((s) => s.startDay));
    console.log(
      `  ${year}: Navkiran ${e?.slots?.length || 0} slots (unique days ${days.size}) vs Tarzan ${t.slots.length}`
    );
  }
  await mongoose.disconnect();
  if (!APPLY) console.log("\nDry run only. Re-run with CONFIRM_PROD=YES ... --apply");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

/**
 * Dry-run: all diary entries → booking slot + shed + subtype (G9 vs Vasai) + 90/10.
 * Does NOT touch existing SB-307 / SB-68 / SB-98 / SB-128 — diary SB → SB-OLD import codes only.
 *
 *   node scripts/dry-run-diary-all-slots.mjs
 */
import dotenv from "dotenv";
import mongoose from "mongoose";
import moment from "moment";
import path from "path";
import { fileURLToPath } from "url";
import DispatchBatch from "../models/dispatchBatch.model.js";
import "../models/plantCms.model.js";
import {
  expectedReadyDateForSecondarySize,
  resolveBookingSlotIdForSecondaryBatch,
  buildBookingSlotLabelMap,
  secondaryInwardCalendarReady,
} from "../services/secondaryShedSlotStock.service.js";
import { splitLagwadQtyForSlot, LAGWAD_ACTUAL_PLANTS_PCT } from "../utility/lagwadSlotPlantsSplit.js";
import PlantSlot from "../models/slots.model.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "../.env") });

const G9_TEMPLATE_BATCH = "424";
const STOCK_DATE = "2026-08-18";
const SIZE = "R1";

/** Existing prod lagwad batches — never reuse these numbers for diary import. */
const PROTECTED_BATCH_NUMBERS = ["SB-307", "SB-68", "SB-98", "SB-128"];

const BANANA_PLANT_ID = "68fdf6d45832d541b274acfa";
const SUBTYPE_VASAI = "68fdf6d45832d541b274acfc";
const SUBTYPE_G9 = "6944c7e75845df7093731ba2";

const fmt = (n) => Number(n || 0).toLocaleString("en-IN");

const diaryBatch = (batch) => {
  const b = String(batch ?? "").trim();
  if (b === "SB") return "SB-OLD";
  return b;
};

/** Location → shed pollyhouse value (matches CMS shade list). */
const LOCATION_TO_SHED = {
  Sinhagad: "Sinhagad (सिंहगड) (1)",
  Raigad: "Raigad (रायगड) (2)",
  Pratapgad: "Pratapgad (प्रतापगड) (4)",
  Torna: "Torna (तोरणा) (5)",
  Purandar: "Purandar (पुरंदर) (6)",
  Rajgad: "Rajgad (राजगड) (7)",
  Devgiri: "Devgiri (देवगिरी) (8)",
  Shivneri: "Shivneri",
  "12 no (Vishal gad)": "12 no (विशाल गड) (12)",
  "23 no": "23 no (विशाल गड) (23)",
};

/** Subtype: Photo 1 is all Vasai; photo 2 batches are G9 unless entry.subtype set. */
function subtypeForEntry(entry) {
  if (entry.subtype) return entry.subtype;
  const b = String(entry.batch ?? "").trim().toLowerCase();
  if (b.includes("vasai")) return "Vasai";
  return "G9";
}

function importBatchCode(location, batch, note, subtypeName) {
  const loc = String(location)
    .replace(/[^\w]+/g, "")
    .slice(0, 8)
    .toUpperCase();
  const b = diaryBatch(batch).replace(/[^\w-]+/g, "");
  const prefix = subtypeName === "Vasai" ? "VAS-D" : "SB-D";
  const suffix = note ? `-${note.replace(/\s+/g, "")}` : "";
  const code = `${prefix}-${loc}-${b}${suffix}`.slice(0, 32);
  if (PROTECTED_BATCH_NUMBERS.includes(code)) {
    throw new Error(`Import code ${code} collides with protected batch`);
  }
  return code;
}

/** Photo 1 — all Vasai variety; Sinhgad has two separate batches (278 + 912). */
const PHOTO_1 = [
  { location: "Sinhagad", batch: "278", plants: 7864, lagwadDate: STOCK_DATE, subtype: "Vasai" },
  { location: "Sinhagad", batch: "912", plants: 12224, lagwadDate: STOCK_DATE, subtype: "Vasai" },
  { location: "Raigad", batch: "911", plants: 91584, lagwadDate: STOCK_DATE, subtype: "Vasai" },
];

const PHOTO_2 = [
  { location: "Pratapgad", batch: "19", plants: 25760 },
  { location: "Pratapgad", batch: "SB", plants: 5132 },
  { location: "Torna", batch: "SB", plants: 9740 },
  { location: "Purandar", batch: "510", plants: 19280 },
  { location: "Purandar", batch: "38", plants: 2496 },
  { location: "Purandar", batch: "19", plants: 36372 },
  { location: "Purandar", batch: "SB", plants: 7872 },
  { location: "Rajgad", batch: "19", plants: 16068 },
  { location: "Rajgad", batch: "38", plants: 1088 },
  { location: "Rajgad", batch: "510", plants: 39180 },
  { location: "Rajgad", batch: "SB", plants: 16751 },
  { location: "Devgiri", batch: "19", plants: 15280 },
  { location: "Devgiri", batch: "38", plants: 11570 },
  { location: "Devgiri", batch: "510", plants: 45700 },
  { location: "Devgiri", batch: "SB", plants: 24382 },
  { location: "Shivneri", batch: "19", plants: 10612 },
  { location: "12 no (Vishal gad)", batch: "mix", plants: 6000 },
  { location: "23 no", batch: "CB", plants: 22456 },
  { location: "Purandar", batch: "mix", plants: 29960, note: "june rope" },
].map((r) => ({ ...r, lagwadDate: STOCK_DATE }));

const ALL_ENTRIES = [
  ...PHOTO_1.map((e) => ({ ...e, photo: "1" })),
  ...PHOTO_2.map((e) => ({ ...e, photo: "2" })),
];

function uri() {
  const url = process.env.PROD_MONGO_URL;
  if (!url) throw new Error("PROD_MONGO_URL missing in .env");
  return url;
}

function templateForSubtype(subtypeName, g9BatchLean) {
  const secDays = Number(g9BatchLean.secondaryPlantReadyDays) || 30;
  if (subtypeName === "Vasai") {
    return {
      plantCmsId: BANANA_PLANT_ID,
      plantSubtypeId: SUBTYPE_VASAI,
      secondaryPlantReadyDays: secDays,
    };
  }
  return {
    plantCmsId: g9BatchLean.plantCmsId ?? BANANA_PLANT_ID,
    plantSubtypeId: g9BatchLean.plantSubtypeId ?? SUBTYPE_G9,
    secondaryPlantReadyDays: secDays,
  };
}

async function main() {
  console.log("=== DRY RUN — Diary entries → slots (G9 vs Vasai · shed-wise · SB-OLD only) ===\n");
  console.log(`G9 template batch ${G9_TEMPLATE_BATCH} · stock date ${STOCK_DATE}`);
  console.log(`Split: ${LAGWAD_ACTUAL_PLANTS_PCT}% sellable actual · 10% mortality`);
  console.log(`Protected (do not import as diary): ${PROTECTED_BATCH_NUMBERS.join(", ")}`);
  console.log("Diary SB column → import as SB-OLD with SB-D-* batch codes only\n");

  await mongoose.connect(uri());

  const g9Batch = await DispatchBatch.findOne({ batchNumber: G9_TEMPLATE_BATCH })
    .select("batchNumber secondaryPlantReadyDays plantCmsId plantSubtypeId")
    .lean();
  if (!g9Batch) throw new Error(`Template ${G9_TEMPLATE_BATCH} missing on PROD`);

  const protectedOnProd = await DispatchBatch.find({
    batchNumber: { $in: PROTECTED_BATCH_NUMBERS },
  })
    .select("batchNumber plantSubtypeId")
    .lean();

  console.log("Existing protected batches on prod (unchanged by this import):");
  for (const b of protectedOnProd) {
    console.log(`  ${b.batchNumber} · subtype ${b.plantSubtypeId}`);
  }
  console.log();

  const importCodes = ALL_ENTRIES.map((e) =>
    importBatchCode(e.location, e.batch, e.note, subtypeForEntry(e))
  );
  const codeCollisions = await DispatchBatch.find({
    batchNumber: { $in: importCodes },
  })
    .select("batchNumber")
    .lean();
  if (codeCollisions.length) {
    console.warn("⚠ Import codes already exist on prod:", codeCollisions.map((c) => c.batchNumber).join(", "));
  } else {
    console.log("Import batch codes: no collision with existing dispatch batches ✓\n");
  }

  const today = moment().startOf("day");
  const rows = [];
  const slotRollup = new Map();
  const subtypeRollup = new Map();
  let noSlot = 0;

  for (const entry of ALL_ENTRIES) {
    const subtypeName = subtypeForEntry(entry);
    const template = templateForSubtype(subtypeName, g9Batch);
    const inward = moment(entry.lagwadDate).startOf("day").toDate();
    const readyDate = expectedReadyDateForSecondarySize(inward, SIZE, template);
    const slotId = await resolveBookingSlotIdForSecondaryBatch(template, readyDate);
    const split = splitLagwadQtyForSlot(entry.plants);
    const batchLabel = diaryBatch(entry.batch);
    const locLabel = entry.note
      ? `${entry.location} (${entry.note})`
      : entry.location;
    const pollyhouse = LOCATION_TO_SHED[entry.location] || entry.location;
    const importBatch = importBatchCode(entry.location, entry.batch, entry.note, subtypeName);

    const siPlain = {
      secondaryInwardDate: inward,
      expectedReadyDate: readyDate,
      size: SIZE,
    };
    const calendarReady = secondaryInwardCalendarReady(siPlain, template, today);

    rows.push({
      photo: entry.photo,
      location: locLabel,
      batchLabel,
      importBatch,
      pollyhouse,
      subtypeName,
      gross: entry.plants,
      actual: split.actualPlants,
      mortality: split.expectedMortality,
      lagwadDate: entry.lagwadDate,
      readyDate: moment(readyDate).format("YYYY-MM-DD"),
      slotId: slotId ? String(slotId) : null,
      calendarReady,
      /** On import (force slot sync): always +actual & +mortality; ready only if calendar eligible. */
      slotDeltaActual: slotId ? split.actualPlants : 0,
      slotDeltaMortality: slotId ? split.expectedMortality : 0,
      slotDeltaReadyToday: slotId && calendarReady ? split.actualPlants : 0,
      slotDeltaReadyOnDate: slotId ? split.actualPlants : 0,
      canInsert: Boolean(slotId) && !codeCollisions.some((c) => c.batchNumber === importBatch),
    });

    if (!slotId) noSlot++;
    else {
      const key = `${subtypeName}::${String(slotId)}`;
      const r = slotRollup.get(key) || {
        subtypeName,
        slotId: String(slotId),
        gross: 0,
        actual: 0,
        mortality: 0,
        lines: 0,
        sheds: new Set(),
      };
      r.gross += entry.plants;
      r.actual += split.actualPlants;
      r.mortality += split.expectedMortality;
      r.lines += 1;
      r.sheds.add(pollyhouse);
      slotRollup.set(key, r);

      const st = subtypeRollup.get(subtypeName) || { gross: 0, actual: 0, mortality: 0, lines: 0 };
      st.gross += entry.plants;
      st.actual += split.actualPlants;
      st.mortality += split.expectedMortality;
      st.lines += 1;
      subtypeRollup.set(subtypeName, st);
    }
  }

  const labelMap = await buildBookingSlotLabelMap(rows.map((r) => r.slotId).filter(Boolean));

  console.log(`\n=== Each entry (22 separate lagwad lines) ===`);
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const slotLabel = r.slotId
      ? labelMap.get(r.slotId)?.label || r.slotId
      : "⚠ NO SLOT";
    console.log(
      `${String(i + 1).padStart(2)}. [${r.subtypeName}] ${r.location} · batch ${r.batchLabel} · import ${r.importBatch} · gross ${fmt(r.gross)} · sell ${fmt(r.actual)} · mort ${fmt(r.mortality)} · shed ${r.pollyhouse} · slot ${slotLabel}`
    );
  }

  console.log(
    "\nPhoto".padEnd(5) +
      "Subtype".padEnd(7) +
      "Location".padEnd(22) +
      "Diary".padEnd(10) +
      "Import".padEnd(24) +
      "Gross".padStart(9) +
      "Sell90%".padStart(9) +
      "Mort".padStart(7) +
      " Ready".padEnd(11) +
      "Slot".padEnd(24) +
      "Shed"
  );
  console.log("-".repeat(145));

  let tG = 0, tA = 0, tM = 0;
  for (const r of rows) {
    tG += r.gross;
    tA += r.actual;
    tM += r.mortality;
    const slotLabel = r.slotId
      ? labelMap.get(r.slotId)?.label || r.slotId
      : "⚠ NO SLOT";
    const readyFlag = r.calendarReady ? "now" : "later";
    console.log(
      r.photo.padEnd(5) +
        r.subtypeName.padEnd(7) +
        String(r.location).slice(0, 21).padEnd(22) +
        String(r.batchLabel).padEnd(10) +
        r.importBatch.padEnd(24) +
        fmt(r.gross).padStart(9) +
        fmt(r.actual).padStart(9) +
        fmt(r.mortality).padStart(7) +
        ` ${r.readyDate}`.padEnd(11) +
        String(slotLabel).slice(0, 23).padEnd(24) +
        `${r.pollyhouse.slice(0, 30)} [${readyFlag}]`
    );
  }

  console.log("-".repeat(145));
  console.log(
    "TOTAL".padEnd(5 + 7 + 22 + 10 + 24) +
      fmt(tG).padStart(9) +
      fmt(tA).padStart(9) +
      fmt(tM).padStart(7)
  );

  console.log(`\n=== Per subtype ===`);
  for (const [name, s] of subtypeRollup) {
    console.log(
      `${name}: ${s.lines} lines · gross ${fmt(s.gross)} · sellable ${fmt(s.actual)} · mort ${fmt(s.mortality)}`
    );
  }

  console.log(`\n=== Per booking slot (subtype + window) ===`);
  for (const [, s] of slotRollup) {
    const label = labelMap.get(s.slotId)?.label || s.slotId;
    const shedList = [...s.sheds].slice(0, 4).join("; ");
    const more = s.sheds.size > 4 ? ` +${s.sheds.size - 4} sheds` : "";
    console.log(
      `${s.subtypeName} · ${label}: ${s.lines} lines · sellable ${fmt(s.actual)} · mort ${fmt(s.mortality)} · sheds: ${shedList}${more}`
    );
  }

  console.log("\n=== Summary ===");
  console.log(`Entries: ${rows.length} (${PHOTO_1.length} photo1 + ${PHOTO_2.length} photo2)`);
  console.log(`Vasai lines: ${rows.filter((r) => r.subtypeName === "Vasai").length} · G9 lines: ${rows.filter((r) => r.subtypeName === "G9").length}`);
  console.log(`Sellable actual 90%: ${fmt(tA)} · mortality: ${fmt(tM)} · gross: ${fmt(tG)}`);
  console.log(`Slot groups: ${slotRollup.size} · missing slot: ${noSlot}`);
  console.log(
    `Calendar sellable today (${today.format("YYYY-MM-DD")}): ${rows.filter((r) => r.calendarReady).length} lines`
  );
  console.log("\nExisting SB-307/68/98/128 lagwad: separate batches · G9 slots · not modified by diary import.");

  // --- Import simulation (same as import-lagwad + syncSecondaryInwardSlotStockAdd force:true) ---
  console.log("\n=== IMPORT DRY RUN — slot ledger deltas (all 22 entries) ===");
  console.log(
    "Logic: lagwad sync → slot +90% actualPlants (sellable pool), +10% expectedMortality.\n" +
      "       actualReadyPlants (dispatch-ready) += sell90% only when calendar ready OR manual mark-ready.\n" +
      `       Today ${today.format("YYYY-MM-DD")}: calendar ready = ${rows.filter((r) => r.calendarReady).length}/22 lines.\n`
  );

  const insertOk = rows.every((r) => r.canInsert);
  const allSlots = rows.every((r) => r.slotId);
  console.log(`All slots resolved: ${allSlots ? "YES ✓" : "NO ✗"} (${rows.filter((r) => r.slotId).length}/22)`);
  console.log(`All entries can insert (new batch codes): ${insertOk ? "YES ✓" : "NO ✗"}`);

  console.log(
    "\n#".padEnd(4) +
      "Import".padEnd(26) +
      "Batch".padEnd(10) +
      "Gross".padStart(8) +
      "+Actual".padStart(9) +
      "+Mort".padStart(8) +
      "+ReadyNow".padStart(10) +
      "+Ready@17Sep".padStart(12) +
      "Slot".padEnd(22) +
      "OK"
  );
  console.log("-".repeat(120));

  let dA = 0, dM = 0, dRNow = 0, dRLater = 0;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    dA += r.slotDeltaActual;
    dM += r.slotDeltaMortality;
    dRNow += r.slotDeltaReadyToday;
    dRLater += r.slotDeltaReadyOnDate;
    const slotLabel = r.slotId
      ? (labelMap.get(r.slotId)?.label || r.slotId).slice(0, 21)
      : "NO SLOT";
    const ok = r.canInsert ? "✓" : "✗";
    console.log(
      String(i + 1).padEnd(4) +
        r.importBatch.padEnd(26) +
        String(r.batchLabel).padEnd(10) +
        fmt(r.gross).padStart(8) +
        fmt(r.slotDeltaActual).padStart(9) +
        fmt(r.slotDeltaMortality).padStart(8) +
        fmt(r.slotDeltaReadyToday).padStart(10) +
        fmt(r.slotDeltaReadyOnDate).padStart(12) +
        slotLabel.padEnd(22) +
        ok
    );
  }
  console.log("-".repeat(120));
  console.log(
    "TOTAL".padEnd(4 + 26 + 10) +
      fmt(rows.reduce((s, r) => s + r.gross, 0)).padStart(8) +
      fmt(dA).padStart(9) +
      fmt(dM).padStart(8) +
      fmt(dRNow).padStart(10) +
      fmt(dRLater).padStart(12)
  );

  const slotIds = [...new Set(rows.map((r) => r.slotId).filter(Boolean))];
  const currentSlots = new Map();
  for (const sid of slotIds) {
    const found = await PlantSlot.findOne({ "subtypeSlots.slots._id": sid })
      .select("subtypeSlots")
      .lean();
    if (!found) continue;
    for (const st of found.subtypeSlots || []) {
      for (const slot of st.slots || []) {
        if (String(slot._id) === sid) {
          currentSlots.set(sid, {
            actualPlants: Number(slot.actualPlants) || 0,
            expectedMortality: Number(slot.expectedMortality) || 0,
            actualReadyPlants: Number(slot.actualReadyPlants) || 0,
          });
        }
      }
    }
  }

  const importRollup = new Map();
  for (const r of rows) {
    if (!r.slotId) continue;
    const agg = importRollup.get(r.slotId) || {
      actual: 0,
      mortality: 0,
      readyToday: 0,
      readyLater: 0,
      lines: 0,
    };
    agg.actual += r.slotDeltaActual;
    agg.mortality += r.slotDeltaMortality;
    agg.readyToday += r.slotDeltaReadyToday;
    agg.readyLater += r.slotDeltaReadyOnDate;
    agg.lines += 1;
    importRollup.set(r.slotId, agg);
  }

  console.log("\n=== Slot BEFORE → AFTER import (diary only) ===");
  for (const sid of slotIds) {
    const cur = currentSlots.get(sid) || { actualPlants: 0, expectedMortality: 0, actualReadyPlants: 0 };
    const delta = importRollup.get(sid);
    const label = labelMap.get(sid)?.label || sid;
    console.log(`\n${label}`);
    console.log(
      `  actualPlants (sellable 90%):     ${fmt(cur.actualPlants)} → ${fmt(cur.actualPlants + delta.actual)} (+${fmt(delta.actual)})`
    );
    console.log(
      `  expectedMortality:               ${fmt(cur.expectedMortality)} → ${fmt(cur.expectedMortality + delta.mortality)} (+${fmt(delta.mortality)})`
    );
    console.log(
      `  actualReadyPlants (if import today): ${fmt(cur.actualReadyPlants)} → ${fmt(cur.actualReadyPlants + delta.readyToday)} (+${fmt(delta.readyToday)})`
    );
    console.log(
      `  actualReadyPlants (from 17 Sep calendar): → ${fmt(cur.actualReadyPlants + delta.readyLater)} (+${fmt(delta.readyLater)})`
    );
    console.log(`  lines: ${delta.lines}`);
  }

  console.log("\n=== Import verdict ===");
  if (allSlots && insertOk) {
    console.log("✓ All 22 entries CAN be imported — each gets a booking slot.");
    console.log("✓ On import today: all +actual & +mortality land on slot; ready stays 0 until 17 Sep or mark-ready.");
    console.log("✓ From 17 Sep (or manual): actualReady += sell90% (same qty as actual sync per line).");
  } else {
    if (!allSlots) console.log("✗ Some entries missing slot — fix calendar before import.");
    if (!insertOk) console.log("✗ Some import batch codes already exist — skip or rename.");
  }

  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

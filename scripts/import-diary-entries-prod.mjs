/**
 * Import diary stock entries (Photo 1 Vasai + Photo 2 G9) on PROD.
 * Does NOT touch SB-307 / SB-68 / SB-98 / SB-128.
 *
 *   node scripts/import-diary-entries-prod.mjs           # dry-run
 *   node scripts/import-diary-entries-prod.mjs --apply   # write PROD
 */
import dotenv from "dotenv";
import mongoose from "mongoose";
import moment from "moment";
import path from "path";
import { fileURLToPath } from "url";
import PlantOutward from "../models/plantOutward.model.js";
import DispatchBatch from "../models/dispatchBatch.model.js";
import { splitLagwadQtyForSlot } from "../utility/lagwadSlotPlantsSplit.js";
import {
  expectedReadyDateForSecondarySize,
  syncSecondaryInwardSlotStockAdd,
  resolveBookingSlotIdForSecondaryBatch,
  secondaryInwardCalendarReady,
} from "../services/secondaryShedSlotStock.service.js";
import { recordSecondaryInwardOnLedger } from "../services/secondaryDispatchAvailability.service.js";
import {
  recordShedActivity,
  SHED_ACTIVITY_ACTIONS,
} from "../services/shedActivity.service.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "../.env") });

const APPLY = process.argv.includes("--apply");
const G9_TEMPLATE_BATCH = "424";
const STOCK_DATE = "2026-08-18";
const SIZE = "R1";
const DEFAULT_CAVITY = 126;
const DEFAULT_LABOURS = 1;

const PROTECTED_BATCH_NUMBERS = ["SB-307", "SB-68", "SB-98", "SB-128"];
const BANANA_PLANT_ID = "68fdf6d45832d541b274acfa";
const SUBTYPE_VASAI = "68fdf6d45832d541b274acfc";
const SUBTYPE_G9 = "6944c7e75845df7093731ba2";

const BATCH_SELECT =
  "batchNumber dateAdded primaryPlantReadyDays secondaryPlantReadyDays plantCmsId plantSubtypeId";

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

function diaryBatch(batch) {
  const b = String(batch ?? "").trim();
  if (b === "SB") return "SB-OLD";
  return b;
}

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

const RAW_ENTRIES = [...PHOTO_1, ...PHOTO_2];

function buildImportEntries() {
  return RAW_ENTRIES.map((e) => {
    const subtypeName = subtypeForEntry(e);
    const pollyhouse = LOCATION_TO_SHED[e.location] || e.location;
    const batchNumber = importBatchCode(e.location, e.batch, e.note, subtypeName);
    return {
      date: e.lagwadDate,
      plants: e.plants,
      batchNumber,
      pollyhouse,
      subtypeName,
      diaryBatch: diaryBatch(e.batch),
      location: e.note ? `${e.location} (${e.note})` : e.location,
    };
  });
}

function uri() {
  const url = process.env.PROD_MONGO_URL;
  if (!url) throw new Error("PROD_MONGO_URL missing in FINAL_NURSERY_BE/.env");
  return url;
}

function templateForSubtype(subtypeName, g9BatchLean) {
  const secDays = Number(g9BatchLean.secondaryPlantReadyDays) || 30;
  if (subtypeName === "Vasai") {
    return {
      plantCmsId: BANANA_PLANT_ID,
      plantSubtypeId: SUBTYPE_VASAI,
      primaryPlantReadyDays: g9BatchLean.primaryPlantReadyDays,
      secondaryPlantReadyDays: secDays,
    };
  }
  return {
    plantCmsId: g9BatchLean.plantCmsId ?? BANANA_PLANT_ID,
    plantSubtypeId: g9BatchLean.plantSubtypeId ?? SUBTYPE_G9,
    primaryPlantReadyDays: g9BatchLean.primaryPlantReadyDays,
    secondaryPlantReadyDays: secDays,
  };
}

async function ensureDispatchBatch(batchNumber, template, session) {
  const bn = String(batchNumber).trim();
  let batch = await DispatchBatch.findOne({ batchNumber: bn })
    .select(BATCH_SELECT)
    .session(session)
    .lean();
  if (batch) return { batch, created: false };

  if (!APPLY) {
    return {
      batch: {
        batchNumber: bn,
        _id: "dry-run-new",
        ...template,
      },
      created: true,
    };
  }

  const doc = await DispatchBatch.create(
    [
      {
        batchNumber: bn,
        dateAdded: new Date(),
        primaryPlantReadyDays: template.primaryPlantReadyDays,
        secondaryPlantReadyDays: template.secondaryPlantReadyDays,
        plantCmsId: template.plantCmsId,
        plantSubtypeId: template.plantSubtypeId,
        isActive: true,
      },
    ],
    { session }
  );
  batch = doc[0].toObject();
  await PlantOutward.create(
    [{ batchId: batch._id, dateAdded: batch.dateAdded || new Date() }],
    { session }
  );
  return { batch, created: true };
}

async function finalizeLagwadRow({
  session,
  batchId,
  plantOutward,
  batchLean,
  row,
  pollyhouse,
}) {
  const siPlain =
    typeof plantOutward.secondaryInward.id(row.secondaryInwardId)?.toObject ===
    "function"
      ? plantOutward.secondaryInward.id(row.secondaryInwardId).toObject()
      : plantOutward.secondaryInward.id(row.secondaryInwardId);
  if (!siPlain) return { syncApplied: 0 };

  const rowExpectedReady = row.expectedReadyDate;

  await recordSecondaryInwardOnLedger(session, {
    dispatchBatchId: batchId,
    plantOutwardId: plantOutward._id,
    secondaryInwardId: row.secondaryInwardId,
    secondaryInwardDate: siPlain.secondaryInwardDate,
    plants: row.plants,
    size: row.size,
  });

  if (!siPlain.linkedBookingSlotId && rowExpectedReady && batchLean) {
    const slotId = await resolveBookingSlotIdForSecondaryBatch(
      batchLean,
      rowExpectedReady
    );
    if (slotId) {
      await PlantOutward.updateOne(
        { batchId, "secondaryInward._id": row.secondaryInwardId },
        { $set: { "secondaryInward.$.linkedBookingSlotId": slotId } },
        { session }
      );
      siPlain.linkedBookingSlotId = slotId;
    }
  }

  await recordShedActivity({
    batchId,
    stage: "secondary_inward",
    subdocId: row.secondaryInwardId,
    action: SHED_ACTIVITY_ACTIONS.SECONDARY_LAGWAD_RECORDED,
    activityName: `Diary import lagwad · ${row.plants} रोप · ${row.size}`,
    quantity: row.plants,
    newValue: {
      size: row.size,
      expectedReadyDate: rowExpectedReady,
      pollyhouse: String(pollyhouse).trim(),
      source: "import-diary-entries-prod",
    },
    session,
  });

  const dispatchEligible = secondaryInwardCalendarReady(
    siPlain,
    batchLean,
    moment().startOf("day")
  );

  return await syncSecondaryInwardSlotStockAdd({
    session,
    batchId,
    secondaryInwardId: row.secondaryInwardId,
    batchLean,
    siPlain,
    dispatchEligible,
    force: true,
  });
}

async function importLagwadEntry(entry, g9Template, session) {
  const template = templateForSubtype(entry.subtypeName, g9Template);
  const { batch, created: batchCreated } = await ensureDispatchBatch(
    entry.batchNumber,
    template,
    session
  );
  const batchId = batch._id;

  if (!APPLY) {
    const inwardDate = moment(entry.date).startOf("day").toDate();
    const rowExpectedReady = expectedReadyDateForSecondarySize(
      inwardDate,
      SIZE,
      batch
    );
    const split = splitLagwadQtyForSlot(entry.plants);
    const slotId = await resolveBookingSlotIdForSecondaryBatch(
      batch,
      rowExpectedReady
    );
    return {
      batchNumber: entry.batchNumber,
      subtypeName: entry.subtypeName,
      batchCreated,
      plants: entry.plants,
      actualPlants: split.actualPlants,
      expectedMortality: split.expectedMortality,
      readyDate: rowExpectedReady,
      slotId: slotId ? String(slotId) : null,
      dryRun: true,
    };
  }

  let plantOutward = await PlantOutward.findOne({ batchId }).session(session);
  if (!plantOutward) {
    const [po] = await PlantOutward.create(
      [{ batchId, dateAdded: new Date() }],
      { session }
    );
    plantOutward = po;
  }

  const inwardDate = moment(entry.date).startOf("day").toDate();
  const rowExpectedReady = expectedReadyDateForSecondarySize(
    inwardDate,
    SIZE,
    batch
  );
  const split = splitLagwadQtyForSlot(entry.plants);
  const traysNum = Math.max(1, Math.ceil(entry.plants / DEFAULT_CAVITY));

  plantOutward.secondaryInward.push({
    secondaryInwardDate: inwardDate,
    numberOfBottles: traysNum,
    size: SIZE,
    cavity: DEFAULT_CAVITY,
    numberOfTrays: traysNum,
    totalQuantity: entry.plants,
    availableQuantity: entry.plants,
    pollyhouse: String(entry.pollyhouse || "").trim(),
    laboursEngaged: DEFAULT_LABOURS,
    transferStatus: "available",
    dateOfDispatch: rowExpectedReady,
    expectedReadyDate: rowExpectedReady,
    remarks: `Diary import · ${entry.subtypeName} · ${entry.location} batch ${entry.diaryBatch}`,
  });
  const pushed =
    plantOutward.secondaryInward[plantOutward.secondaryInward.length - 1];
  await plantOutward.save({ session, validateModifiedOnly: true });

  const syncResult = await finalizeLagwadRow({
    session,
    batchId,
    plantOutward,
    batchLean: batch,
    row: {
      size: SIZE,
      plants: entry.plants,
      secondaryInwardId: String(pushed._id),
      expectedReadyDate: rowExpectedReady,
    },
    pollyhouse: String(entry.pollyhouse || "").trim(),
  });

  return {
    batchNumber: entry.batchNumber,
    subtypeName: entry.subtypeName,
    batchCreated,
    plants: entry.plants,
    actualPlants: split.actualPlants,
    expectedMortality: split.expectedMortality,
    readyDate: rowExpectedReady,
    slotId: syncResult?.slotId,
    syncApplied: syncResult?.applied ?? 0,
    readyApplied: syncResult?.applied && secondaryInwardCalendarReady(
      {
        secondaryInwardDate: inwardDate,
        expectedReadyDate: rowExpectedReady,
        size: SIZE,
      },
      batch,
      moment().startOf("day")
    ) ? syncResult.applied : 0,
  };
}

async function sumSlotLagwadFields() {
  const col = mongoose.connection.db.collection("plantslots");
  const docs = await col.find({}).project({ subtypeSlots: 1 }).toArray();
  let actual = 0;
  let mortality = 0;
  let ready = 0;
  for (const doc of docs) {
    for (const st of doc.subtypeSlots || []) {
      for (const slot of st.slots || []) {
        actual += Number(slot.actualPlants) || 0;
        mortality += Number(slot.expectedMortality) || 0;
        ready += Number(slot.actualReadyPlants) || 0;
      }
    }
  }
  return { actual, mortality, ready };
}

async function main() {
  const ENTRIES = buildImportEntries();
  console.log(
    APPLY
      ? "=== APPLY — diary import on PROD (22 entries) ==="
      : "=== DRY RUN — diary import (no writes) ==="
  );

  await mongoose.connect(uri());

  const g9Template = await DispatchBatch.findOne({
    batchNumber: G9_TEMPLATE_BATCH,
  })
    .select(BATCH_SELECT)
    .lean();
  if (!g9Template) {
    throw new Error(`Template batch ${G9_TEMPLATE_BATCH} not found on PROD`);
  }

  const existing = await DispatchBatch.find({
    batchNumber: { $in: ENTRIES.map((e) => e.batchNumber) },
  })
    .select("batchNumber")
    .lean();
  if (existing.length) {
    const names = existing.map((b) => b.batchNumber).join(", ");
    if (APPLY) {
      throw new Error(`Batch codes already exist — abort: ${names}`);
    }
    console.warn(`⚠ Already on prod: ${names}`);
  }

  const before = await sumSlotLagwadFields();
  console.log("Slot totals BEFORE:", before);
  console.log(`Entries: ${ENTRIES.length} · Vasai ${PHOTO_1.length} · G9 ${PHOTO_2.length}\n`);

  let totalLagwad = 0;
  let totalActual = 0;
  let totalMortality = 0;

  if (APPLY) {
    const session = await mongoose.startSession();
    session.startTransaction();
    try {
      for (const entry of ENTRIES) {
        const r = await importLagwadEntry(entry, g9Template, session);
        totalLagwad += entry.plants;
        totalActual += r.actualPlants;
        totalMortality += r.expectedMortality;
        console.log(
          `[import] ${entry.subtypeName} ${entry.batchNumber} (${entry.diaryBatch}) ${entry.plants.toLocaleString()} → sync ${r.syncApplied} slot ${r.slotId || "—"}${r.batchCreated ? " new-batch" : ""}`
        );
      }
      await session.commitTransaction();
    } catch (err) {
      await session.abortTransaction();
      throw err;
    } finally {
      session.endSession();
    }
  } else {
    for (const entry of ENTRIES) {
      const r = await importLagwadEntry(entry, g9Template, null);
      totalLagwad += entry.plants;
      totalActual += r.actualPlants;
      totalMortality += r.expectedMortality;
      console.log(
        `[plan] ${entry.subtypeName} ${entry.batchNumber} ${entry.plants.toLocaleString()} → actual ${r.actualPlants.toLocaleString()} mort ${r.expectedMortality.toLocaleString()} slot ${r.slotId || "—"}${r.batchCreated ? " (new)" : ""}`
      );
    }
  }

  const after = await sumSlotLagwadFields();
  console.log("\n--- Summary ---");
  console.log(`Lagwad gross: ${totalLagwad.toLocaleString()}`);
  console.log(`Slot actual 90%: ${totalActual.toLocaleString()}`);
  console.log(`Slot mortality 10%: ${totalMortality.toLocaleString()}`);
  console.log("Slot totals AFTER:", after);
  console.log("Delta:", {
    actual: after.actual - before.actual,
    mortality: after.mortality - before.mortality,
    ready: after.ready - before.ready,
  });

  if (!APPLY) {
    console.log("\nRe-run with --apply to write to PROD.");
  }

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

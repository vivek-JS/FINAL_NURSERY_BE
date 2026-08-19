/**
 * Import lagwad diary entries on PROD (direct lagwad + slot 90/10 sync).
 *
 *   node scripts/import-lagwad-entries-prod.mjs           # dry-run
 *   node scripts/import-lagwad-entries-prod.mjs --apply   # write PROD
 */
import dotenv from "dotenv";
import mongoose from "mongoose";
import moment from "moment";
import path from "path";
import { fileURLToPath } from "url";
import PlantOutward from "../models/plantOutward.model.js";
import DispatchBatch from "../models/dispatchBatch.model.js";
import { safeNonNegativeInt } from "../utility/safeMongooseNumber.js";
import { splitLagwadQtyForSlot } from "../utility/lagwadSlotPlantsSplit.js";
import {
  expectedReadyDateForSecondarySize,
  syncSecondaryInwardSlotStockAdd,
  resolveBookingSlotIdForSecondaryBatch,
  secondaryInwardCalendarReady,
} from "../services/secondaryShedSlotStock.service.js";
import {
  recordSecondaryInwardOnLedger,
} from "../services/secondaryDispatchAvailability.service.js";
import {
  recordShedActivity,
  SHED_ACTIVITY_ACTIONS,
} from "../services/shedActivity.service.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "../.env") });

const APPLY = process.argv.includes("--apply");
const TEMPLATE_BATCH_NUMBER = "424";
const DEFAULT_CAVITY = 126;
const DEFAULT_LABOURS = 1;

const ENTRIES = [
  {
    date: "2026-08-02",
    plants: 42992,
    batchNumber: "SB-307",
    pollyhouse: "23 no (विशाल गड) (23)",
  },
  {
    date: "2026-08-07",
    plants: 41280,
    batchNumber: "SB-68",
    pollyhouse: "23 no (विशाल गड) (23)",
  },
  {
    date: "2026-08-10",
    plants: 41168,
    batchNumber: "SB-98",
    pollyhouse: "23 no (विशाल गड) (23)",
  },
  {
    date: "2026-08-17",
    plants: 41048,
    batchNumber: "SB-128",
    pollyhouse: "Torna (तोरणा) (5)",
  },
];

const BATCH_SELECT =
  "batchNumber dateAdded primaryPlantReadyDays secondaryPlantReadyDays plantCmsId plantSubtypeId";

function uri() {
  const url = process.env.PROD_MONGO_URL;
  if (!url) throw new Error("PROD_MONGO_URL missing in FINAL_NURSERY_BE/.env");
  return url;
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
        plantCmsId: template.plantCmsId,
        plantSubtypeId: template.plantSubtypeId,
        primaryPlantReadyDays: template.primaryPlantReadyDays,
        secondaryPlantReadyDays: template.secondaryPlantReadyDays,
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
    activityName: `लागवड import · ${row.plants} रोप · ${row.size}`,
    quantity: row.plants,
    newValue: {
      size: row.size,
      expectedReadyDate: rowExpectedReady,
      pollyhouse: String(pollyhouse).trim(),
      source: "import-lagwad-entries-prod",
    },
    session,
  });

  const dispatchEligible = secondaryInwardCalendarReady(
    siPlain,
    batchLean,
    moment().startOf("day")
  );

  const syncResult = await syncSecondaryInwardSlotStockAdd({
    session,
    batchId,
    secondaryInwardId: row.secondaryInwardId,
    batchLean: batchLean,
    siPlain,
    dispatchEligible,
    force: true,
  });

  return syncResult;
}

async function importLagwadEntry(entry, template, session) {
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
      "R1",
      batch
    );
    const split = splitLagwadQtyForSlot(entry.plants);
    return {
      batchNumber: entry.batchNumber,
      batchCreated,
      plants: entry.plants,
      actualPlants: split.actualPlants,
      expectedMortality: split.expectedMortality,
      readyDate: rowExpectedReady,
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
    "R1",
    batch
  );
  const split = splitLagwadQtyForSlot(entry.plants);

  const traysNum = Math.max(1, Math.ceil(entry.plants / DEFAULT_CAVITY));
  plantOutward.secondaryInward.push({
    secondaryInwardDate: inwardDate,
    numberOfBottles: traysNum,
    size: "R1",
    cavity: DEFAULT_CAVITY,
    numberOfTrays: traysNum,
    totalQuantity: entry.plants,
    availableQuantity: entry.plants,
    pollyhouse: String(entry.pollyhouse || "").trim(),
    laboursEngaged: DEFAULT_LABOURS,
    transferStatus: "available",
    dateOfDispatch: rowExpectedReady,
    expectedReadyDate: rowExpectedReady,
    remarks: `Prod import lagwad · SB batch ${entry.batchNumber}`,
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
      size: "R1",
      plants: entry.plants,
      secondaryInwardId: String(pushed._id),
      expectedReadyDate: rowExpectedReady,
    },
    pollyhouse: String(entry.pollyhouse || "").trim(),
  });

  return {
    batchNumber: entry.batchNumber,
    batchCreated,
    plants: entry.plants,
    actualPlants: split.actualPlants,
    expectedMortality: split.expectedMortality,
    readyDate: rowExpectedReady,
    slotId: syncResult?.slotId,
    syncApplied: syncResult?.applied ?? 0,
    mortalityApplied: syncResult?.mortalityApplied ?? 0,
  };
}

async function sumSlotLagwadFields() {
  const col = mongoose.connection.db.collection("plantslots");
  const docs = await col.find({}).project({ subtypeSlots: 1 }).toArray();
  let actual = 0;
  let mortality = 0;
  let ready = 0;
  let lagwadRem = 0;
  for (const doc of docs) {
    for (const st of doc.subtypeSlots || []) {
      for (const slot of st.slots || []) {
        actual += Number(slot.actualPlants) || 0;
        mortality += Number(slot.expectedMortality) || 0;
        ready += Number(slot.actualReadyPlants) || 0;
        lagwadRem += Number(slot.lagwadRemaining) || 0;
      }
    }
  }
  return { actual, mortality, ready, lagwadRem };
}

async function main() {
  console.log(
    APPLY
      ? "=== APPLY — import lagwad entries on PROD ==="
      : "=== DRY RUN — lagwad import (no writes) ==="
  );

  await mongoose.connect(uri());

  const template = await DispatchBatch.findOne({
    batchNumber: TEMPLATE_BATCH_NUMBER,
  })
    .select(BATCH_SELECT)
    .lean();
  if (!template) {
    throw new Error(`Template batch ${TEMPLATE_BATCH_NUMBER} not found on PROD`);
  }
  console.log(
    `Template batch ${TEMPLATE_BATCH_NUMBER}: plant ${template.plantCmsId} subtype ${template.plantSubtypeId} secDays ${template.secondaryPlantReadyDays}`
  );

  const before = await sumSlotLagwadFields();
  console.log("\nSlot totals BEFORE:", before);

  let totalLagwad = 0;
  let totalActual = 0;
  let totalMortality = 0;
  const results = [];

  if (APPLY) {
    const session = await mongoose.startSession();
    session.startTransaction();
    try {
      for (const entry of ENTRIES) {
        const r = await importLagwadEntry(entry, template, session);
        results.push(r);
        totalLagwad += entry.plants;
        totalActual += r.actualPlants;
        totalMortality += r.expectedMortality;
        console.log(
          `[import] ${entry.date} batch ${entry.batchNumber}: ${entry.plants.toLocaleString()} plants → slot sync ${r.syncApplied} (+mortality ${r.mortalityApplied}) slot ${r.slotId || "—"}`
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
      const session = null;
      const r = await importLagwadEntry(entry, template, session);
      results.push(r);
      totalLagwad += entry.plants;
      totalActual += r.actualPlants;
      totalMortality += r.expectedMortality;
      console.log(
        `[plan] ${entry.date} batch ${entry.batchNumber}: lagwad ${entry.plants.toLocaleString()} → actual ${r.actualPlants.toLocaleString()} mortality ${r.expectedMortality.toLocaleString()} ready ${moment(r.readyDate).format("YYYY-MM-DD")}${r.batchCreated ? " (new batch)" : ""}`
      );
    }
  }

  const after = await sumSlotLagwadFields();
  console.log("\n--- Summary ---");
  console.log(`Lagwad lines: ${ENTRIES.length}`);
  console.log(`Total lagwad plants: ${totalLagwad.toLocaleString()}`);
  console.log(`Expected actual (90%): ${totalActual.toLocaleString()}`);
  console.log(`Expected mortality (10%): ${totalMortality.toLocaleString()}`);
  console.log("Slot totals AFTER:", after);

  if (!APPLY) {
    console.log("\nRe-run with --apply to write to PROD.");
  }

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

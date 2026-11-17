/**
 * Papaya diary sowings (Aug–Oct 2026).
 * 15 no uses 40% mortality. Taiwan, Vikram 77, and W-46 use 15%.
 * Rows already sown are retargeted. Missing rows are created as excess stock.
 *   node scripts/add-papaya-sowing-entries.mjs
 *   node scripts/add-papaya-sowing-entries.mjs --apply
 */
import dotenv from "dotenv";
import mongoose from "mongoose";
import path from "path";
import { fileURLToPath } from "url";
import PlantCms from "../models/plantCms.model.js";
import PlantSlot from "../models/slots.model.js";
import SowingRequest from "../models/sowingRequest.model.js";
import { sowQtySlotImpact } from "../utility/lagwadSlotPlantsSplit.js";
import { applyStockFieldUpdates } from "../utility/slotStockTrail.js";
import {
  applyPlantsToLinkedSlots,
  pushEvent,
} from "../controllers/sowingCompleteHelpers.js";
import {
  addDays,
  findSlotByPlantReadyDate,
  fmtDDMMYYYY,
  toSowYmd,
} from "../controllers/sowingSlotReadyHelpers.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "..", ".env") });

const APPLY = process.argv.includes("--apply");
const TAG = "papaya-diary-aug-oct-2026";

/** Sheet varieties: 15 No. → 15 no, V-77 → Vikram 77, WS-46 → W-46. */
const ROWS = [
  { date: "2026-08-18", variety: "15 no", qty: 16320, mort: 40 },
  { date: "2026-08-31", variety: "15 no", qty: 15360, mort: 40 },
  { date: "2026-09-01", variety: "Vikram 77", qty: 5820, mort: 15 },
  { date: "2026-09-06", variety: "Taiwan", qty: 5820, mort: 15 },
  { date: "2026-09-07", variety: "15 no", qty: 18960, mort: 40 },
  { date: "2026-09-07", variety: "Vikram 77", qty: 5760, mort: 15 },
  { date: "2026-09-08", variety: "15 no", qty: 12240, mort: 40 },
  { date: "2026-09-08", variety: "W-46", qty: 4560, mort: 15 },
  { date: "2026-09-17", variety: "15 no", qty: 18720, mort: 40 },
  { date: "2026-09-17", variety: "Vikram 77", qty: 6540, mort: 15 },
  { date: "2026-09-22", variety: "15 no", qty: 34080, mort: 40 },
  { date: "2026-09-29", variety: "15 no", qty: 25680, mort: 40 },
  { date: "2026-09-29", variety: "Vikram 77", qty: 6120, mort: 15 },
  { date: "2026-10-07", variety: "15 no", qty: 46080, mort: 40 },
  { date: "2026-10-08", variety: "15 no", qty: 7200, mort: 40 },
  { date: "2026-10-09", variety: "Taiwan", qty: 6360, mort: 15 },
  { date: "2026-10-12", variety: "15 no", qty: 49200, mort: 40 },
];

const n = (v) => Math.max(0, Math.floor(Number(v) || 0));

function ymdOf(value) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  return d.toISOString().slice(0, 10);
}

function noonUtc(ymd) {
  return new Date(`${ymd}T12:00:00.000Z`);
}

function splitAt(plants, mort) {
  return sowQtySlotImpact(plants, { isExcess: true, mortalityPct: mort });
}

function locateBatch(plantSlot, requestId) {
  const want = String(requestId);
  for (const st of plantSlot?.subtypeSlots || []) {
    for (const slot of st.slots || []) {
      const batch = (slot.sowingBatches || []).find(
        (b) => String(b.sowingRequestId) === want
      );
      if (batch) return { slot, batch };
    }
  }
  return null;
}

async function findExisting(plantId, row) {
  const rows = await SowingRequest.find({
    plantId,
    subtypeName: row.variety,
    sowedQuantity: row.qty,
    sowingCompleted: true,
  })
    .select("requestNumber subtypeName sowedQuantity sowingCompletedDate notes")
    .lean();
  const hits = rows.filter((r) => ymdOf(r.sowingCompletedDate) === row.date);
  return (
    hits.find((r) => String(r.notes || "").includes("Excessive sowing")) ||
    hits.find((r) => String(r.notes || "").includes(TAG)) ||
    hits[0] ||
    null
  );
}

async function retargetMortality({ request, mort, adminId }) {
  const plantSlot = await PlantSlot.findOne({
    "subtypeSlots.slots.sowingBatches.sowingRequestId": request._id,
  });
  const found = locateBatch(plantSlot, request._id);
  if (!found) return { action: "missing-batch", requestNumber: request.requestNumber };

  const { slot, batch } = found;
  if (n(batch.mortalityPct) === mort && n(batch.plantsSowed) === n(request.sowedQuantity)) {
    const current = splitAt(batch.plantsSowed, mort);
    if (n(batch.actualPlantsApplied) === current.actualPlants) {
      return { action: "already", requestNumber: request.requestNumber, mort };
    }
  }

  const oldActual = n(batch.actualPlantsApplied);
  const oldAvail = n(batch.availablePlantsApplied);
  const oldMort = n(batch.expectedMortalityApplied);
  const allocated = Math.max(0, oldActual - oldAvail);
  const impact = splitAt(n(batch.plantsSowed), mort);
  const newAvail = Math.max(0, impact.actualPlants - allocated);
  const deltaActual = impact.actualPlants - oldActual;
  const deltaMort = impact.expectedMortality - oldMort;
  const deltaAvail = newAvail - oldAvail;
  const preview = {
    action: "retarget",
    requestNumber: request.requestNumber,
    variety: request.subtypeName,
    plants: n(batch.plantsSowed),
    mort,
    fromActual: oldActual,
    toActual: impact.actualPlants,
    fromMort: oldMort,
    toMort: impact.expectedMortality,
    deltaAvail,
    allocated,
  };
  if (!APPLY) return preview;

  batch.actualPlantsApplied = impact.actualPlants;
  batch.expectedMortalityApplied = impact.expectedMortality;
  batch.availablePlantsApplied = newAvail;
  batch.mortalityPct = mort;
  if (slot.excessiveSowing) {
    slot.excessiveSowing.plants = Math.max(0, n(slot.excessiveSowing.plants) + deltaAvail);
  }
  applyStockFieldUpdates(
    slot,
    {
      actualPlants: Math.max(0, n(slot.actualPlants) + deltaActual),
      expectedMortality: Math.max(0, n(slot.expectedMortality) + deltaMort),
      availablePlants: Math.max(0, n(slot.availablePlants) + deltaAvail),
    },
    adminId,
    `Papaya mortality ${mort}% · ${request.requestNumber}`
  );
  if (adminId) slot.setPerformer?.(adminId);
  await plantSlot.save({ validateBeforeSave: true });
  return { ...preview, saved: true };
}

async function createEntry({ plant, subtype, row, adminId }) {
  const sowedAt = noonUtc(row.date);
  const readyDays = n(subtype.plantReadyDays) || 40;
  const existing = await findExisting(plant._id, row);
  if (existing) return retargetMortality({ request: existing, mort: row.mort, adminId });

  const readyOn = fmtDDMMYYYY(addDays(sowedAt, readyDays));
  const slot = await findSlotByPlantReadyDate(plant._id, subtype._id, readyOn);
  const preview = {
    action: "create",
    variety: subtype.name,
    date: row.date,
    plants: row.qty,
    mort: row.mort,
    readyDays,
    slotId: slot?.slotId ? String(slot.slotId) : null,
    ready: slot?.plantReadyDate || null,
  };
  if (!slot?.slotId) return { ...preview, error: "no ready slot" };
  if (!APPLY) return preview;

  const requestNumber = await SowingRequest.generateRequestNumber();
  const notes = `${TAG} · ${subtype.name} · ${row.qty} plants · mortality ${row.mort}%`;
  const request = new SowingRequest({
    requestNumber,
    plantId: plant._id,
    plantName: plant.name,
    subtypeId: subtype._id,
    subtypeName: subtype.name,
    packetsNeeded: 0,
    packetsRequested: 0,
    excessPackets: 0,
    conversionFactor: 1,
    unitName: "packets",
    status: "issued",
    requestedBy: adminId,
    issuedBy: adminId,
    issuedDate: sowedAt,
    notes,
    linkedSlotIds: [slot.slotId],
    linkedOrderIds: [],
    isExcessiveSowing: true,
    seedSource: "COMPANY",
    packetsFromCompany: 0,
    packetsFromRaising: 0,
    packetsIssued: 0,
    packetsUsed: 0,
    packetsReturned: 0,
    sowedQuantity: row.qty,
    shedName: "Office",
    completionNotes: notes,
    completedBy: adminId,
    sowingCompleted: true,
    sowingCompletedDate: sowedAt,
    sowingInProgress: false,
    remainingSowingNeeded: 0,
    completionEvents: [],
  });

  const slotResult = await applyPlantsToLinkedSlots(request, row.qty, {
    packetsUsed: 0,
    requestNumber,
    linkedOrderIds: [],
    isExcessiveSowing: true,
    shedName: "Office",
    sowedAt,
    plantReadyDays: readyDays,
    mortalityPct: row.mort,
    resolveByReadyDate: true,
    userId: adminId,
  });
  pushEvent(request, {
    type: "SOW_COMPLETED",
    by: adminId,
    quantity: row.qty,
    unit: "plants",
    message: `Papaya diary: ${row.qty} plants · mortality ${row.mort}%`,
    meta: {
      tag: TAG,
      excessOnly: true,
      mortalityPct: row.mort,
      sowDate: toSowYmd(sowedAt),
      plantReadyDate: slotResult.plantReadyDate || null,
      appliedSlotId: slotResult.appliedSlotId ? String(slotResult.appliedSlotId) : null,
    },
  });
  await request.saveWithUniqueRequestNumber();
  return {
    ...preview,
    saved: true,
    requestNumber: request.requestNumber,
    ready: slotResult.plantReadyDate,
    actual: slotResult.actualPlants,
    mortality: slotResult.expectedMortality,
  };
}

async function main() {
  const uri = process.env.PROD_MONGO_URL || process.env.MONGO_URL;
  if (!uri) throw new Error("Missing MONGO_URL / PROD_MONGO_URL");
  await mongoose.connect(uri);

  const plant = await PlantCms.findOne({ name: /^papaya$/i }).select(
    "name subtypes._id subtypes.name subtypes.plantReadyDays"
  );
  if (!plant) throw new Error("Papaya plant missing");
  const admin = await mongoose.connection.db.collection("users").findOne({
    jobTitle: "SUPER_ADMIN",
  });
  if (!admin?._id) throw new Error("Super admin missing");

  const results = [];
  for (const row of ROWS) {
    const subtype = (plant.subtypes || []).find((s) => s.name === row.variety);
    if (!subtype) {
      results.push({ ...row, error: "subtype missing" });
      continue;
    }
    const existing = await findExisting(plant._id, row);
    if (existing) {
      results.push(await retargetMortality({ request: existing, mort: row.mort, adminId: admin._id }));
    } else {
      results.push(await createEntry({ plant, subtype, row, adminId: admin._id }));
    }
  }
  console.log(JSON.stringify({ apply: APPLY, results }, null, 2));
}

try {
  await main();
} finally {
  if (mongoose.connection.readyState) await mongoose.disconnect();
}

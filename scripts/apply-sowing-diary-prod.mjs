/**
 * Replace existing sowing entries with physical diary (49 rows).
 * Does NOT mark or unmark any orders. Inventory / raising intakes untouched.
 *
 *   node scripts/apply-sowing-diary-prod.mjs
 *   node scripts/apply-sowing-diary-prod.mjs --apply
 */
import dotenv from "dotenv";
import mongoose from "mongoose";
import path from "path";
import { fileURLToPath } from "url";
import PlantCms from "../models/plantCms.model.js";
import Product from "../models/product.model.js";
import PlantSlot from "../models/slots.model.js";
import Sowing from "../models/sowing.model.js";
import SowingRequest from "../models/sowingRequest.model.js";
import {
  pushEvent,
  applyPlantsToLinkedSlots,
  reverseSowBatchFromSlot,
} from "../controllers/sowingCompleteHelpers.js";
import {
  addDays,
  fmtDDMMYYYY,
  findSlotByPlantReadyDate,
} from "../controllers/sowingSlotReadyHelpers.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "../.env") });

const APPLY = process.argv.includes("--apply");
const READY_DAYS = 18;
const YEAR = 2026;
const TAG = "diary-sow-2026";
const fmt = (n) => Number(n || 0).toLocaleString("en-IN");

const ALIASES = {
  impact: "Impact",
  melody: "Melody",
  simbha: "SImbha",
  bhujang: "Bhujang Plus",
  "bhujang+": "Bhujang Plus",
  "bhujang plus": "Bhujang Plus",
  kargil: "Karlgil Plus",
  redking: "Redking",
  "red king": "Redking",
  singham: "Singham",
  vijay: "Vijay",
  shivaji: "Shivaji",
};

const ROWS = [
  { sow: "5-Jul", variety: "Melody", qty: 20916, raising: false, batches: [{ batch: "2600376", pkt: 2 }, { batch: "2601433", pkt: 15 }] },
  { sow: "9-Jul", variety: "Melody", qty: 58590, raising: true, batches: [{ batch: "2601433", pkt: 37 }, { batch: "2600354", pkt: 11 }] },
  { sow: "10-Jul", variety: "Singham", qty: 47250, raising: false, batches: [{ batch: "12-0925-325", pkt: 24 }, { batch: "R50-270-522/1/2", pkt: 20 }] },
  { sow: "11-Jul", variety: "Vijay", qty: 15498, raising: false, batches: [{ batch: "A02731", pkt: 13 }] },
  { sow: "13-Jul", variety: "Melody", qty: 13482, raising: false, batches: [{ batch: "2602506", pkt: 9 }, { batch: "2601433", pkt: 2 }] },
  { sow: "19-Jul", variety: "Simbha", qty: 63378, raising: false, batches: [{ batch: "21092374", pkt: 62 }] },
  { sow: "20-Jul", variety: "Singham", qty: 24318, raising: false, batches: [{ batch: "R50-270-522/1/2", pkt: 22 }] },
  { sow: "20-Jul", variety: "Simbha", qty: 7938, raising: false, batches: [{ batch: "21092374", pkt: 22 }] },
  { sow: "21-Jul", variety: "Melody", qty: 20412, raising: true, batches: [{ batch: "2602605", pkt: 15 }] },
  { sow: "21-Jul", variety: "Impact", qty: 21546, raising: false, batches: [{ batch: "37529301004", pkt: 21 }] },
  { sow: "22-Jul", variety: "Melody", qty: 20286, raising: false, batches: [{ batch: "2602506", pkt: 15 }] },
  { sow: "22-Jul", variety: "Vijay", qty: 20412, raising: false, batches: [{ batch: "A02731", pkt: 17 }] },
  { sow: "24-Jul", variety: "Melody", qty: 10080, raising: false, batches: [{ batch: "2602506", pkt: 6 }, { batch: "2602559", pkt: 2 }] },
  { sow: "24-Jul", variety: "Vijay", qty: 29106, raising: false, batches: [{ batch: "A02731", pkt: 24 }] },
  { sow: "25-Jul", variety: "Impact", qty: 22932, raising: false, batches: [{ batch: "37438001004", pkt: 21 }, { batch: "35472501004", pkt: 2 }] },
  { sow: "25-Jul", variety: "Simbha", qty: 40068, raising: false, batches: [{ batch: "0021092374", pkt: 10 }, { batch: "0021039884", pkt: 10 }, { batch: "0021399648", pkt: 13 }, { batch: "0021046327", pkt: 6 }] },
  { sow: "27-Jul", variety: "Simbha", qty: 18270, raising: false, batches: [{ batch: "21046327", pkt: 18 }] },
  { sow: "27-Jul", variety: "Melody", qty: 10017, raising: true, batches: [{ batch: "2601461", pkt: 8 }] },
  { sow: "27-Jul", variety: "Melody", qty: 22176, raising: true, batches: [{ batch: "2602506", pkt: 18 }] },
  { sow: "27-Jul", variety: "Melody", qty: 12348, raising: false, batches: [{ batch: "2602559", pkt: 9 }] },
  { sow: "27-Jul", variety: "Singham", qty: 20160, raising: false, batches: [{ batch: "R50270-522/1/2", pkt: 17 }] },
  { sow: "28-Jul", variety: "Impact", qty: 15750, raising: false, batches: [{ batch: "35438001004", pkt: 16 }] },
  { sow: "28-Jul", variety: "Bhujang+", qty: 10458, raising: true, batches: [{ batch: "SNX-2006", pkt: 8 }] },
  { sow: "28-Jul", variety: "Shivaji", qty: 105336, raising: true, batches: [{ batch: "25227", pkt: 80 }] },
  { sow: "28-Jul", variety: "Red King", qty: 47124, raising: true, batches: [{ batch: "GRB-JLN-261", pkt: 45 }] },
  { sow: "29-Jul", variety: "Melody", qty: 27342, raising: true, batches: [{ batch: "2601329", pkt: 20 }] },
  { sow: "29-Jul", variety: "Kargil", qty: 177030, raising: true, batches: [{ batch: "25221", pkt: 130 }] },
  { sow: "29-Jul", variety: "Melody", qty: 18522, raising: true, batches: [{ batch: "2601461", pkt: 15 }] },
  { sow: "29-Jul", variety: "Melody", qty: 17514, raising: true, batches: [{ batch: "2601461", pkt: 14 }] },
  { sow: "30-Jul", variety: "Melody", qty: 13482, raising: true, batches: [{ batch: "2601461", pkt: 3 }, { batch: "2602605", pkt: 7 }] },
  { sow: "30-Jul", variety: "Impact", qty: 15237, raising: true, batches: [{ batch: "37437701004", pkt: 15 }] },
  { sow: "2-Aug", variety: "Simbha", qty: 42960, raising: false, batches: [{ batch: "21050026", pkt: 43 }] },
  { sow: "3-Aug", variety: "Red King", qty: 29736, raising: false, batches: [{ batch: "GRB-JLN-261", pkt: 28 }] },
  { sow: "3-Aug", variety: "Impact", qty: 15750, raising: false, batches: [{ batch: "37438001004", pkt: 16 }] },
  { sow: "4-Aug", variety: "Singham", qty: 46620, raising: false, batches: [{ batch: "R50-270-522/1/2", pkt: 41 }] },
  { sow: "7-Aug", variety: "Red King", qty: 19040, raising: false, batches: [{ batch: "GRB-JLN-261", pkt: 17 }] },
  { sow: "9-Aug", variety: "Simbha", qty: 20160, raising: false, batches: [{ batch: "21050026", pkt: 20 }] },
  { sow: "9-Aug", variety: "Melody", qty: 34272, raising: false, batches: [{ batch: "2602569", pkt: 27 }] },
  { sow: "9-Aug", variety: "Melody", qty: 17262, raising: true, batches: [{ batch: "2601461", pkt: 14 }] },
  { sow: "9-Aug", variety: "Bhujang+", qty: 17262, raising: true, batches: [{ batch: "SNX-2008", pkt: 14 }] },
  { sow: "11-Aug", variety: "Melody", qty: 11313, raising: true, batches: [{ batch: "2602569", pkt: 9 }] },
  { sow: "12-Aug", variety: "Red King", qty: 7938, raising: false, batches: [{ batch: "GRB-JLN-261", pkt: 8 }] },
  { sow: "12-Aug", variety: "Melody", qty: 11466, raising: true, batches: [{ batch: "2602569", pkt: 9 }] },
  { sow: "16-Aug", variety: "Simbha", qty: 11844, raising: false, batches: [{ batch: "21050026", pkt: 11 }] },
  { sow: "16-Aug", variety: "Bhujang+", qty: 9576, raising: true, batches: [{ batch: "SNX-2031", pkt: 1.5 }] },
  { sow: "16-Aug", variety: "Melody", qty: 54180, raising: false, batches: [{ batch: "2602569", pkt: 43 }] },
  { sow: "16-Aug", variety: "Impact", qty: 11214, raising: false, batches: [{ batch: "37593601004", pkt: 10 }] },
  { sow: "16-Aug", variety: "Vijay", qty: 29106, raising: false, batches: [{ batch: "A02731", pkt: 25 }] },
  { sow: "17-Aug", variety: "Red King", qty: 75096, raising: false, batches: [{ batch: "GRB-JLN-261", pkt: 71 }] },
];

function norm(s) {
  return String(s || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[^a-z0-9+ ]/g, "");
}

function canonical(name) {
  const n = norm(name);
  return ALIASES[n] || ALIASES[n.replace(/\+/g, "").trim()] || String(name).trim();
}

function parseDiaryDate(token) {
  const m = String(token || "")
    .trim()
    .match(/^(\d{1,2})-([A-Za-z]{3})$/);
  if (!m) return null;
  const months = {
    jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
    jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
  };
  const mon = months[m[2].toLowerCase()];
  if (mon == null) return null;
  return new Date(YEAR, mon, parseInt(m[1], 10), 12, 0, 0, 0);
}

function batchStr(batches) {
  return (batches || []).map((b) => `${b.pkt}pkt ${b.batch}`).join(" + ");
}

function pktTotal(batches) {
  return (batches || []).reduce((s, b) => s + (Number(b.pkt) || 0), 0);
}

function resolveSubtype(wantName, plants) {
  const want = norm(wantName);
  for (const plant of plants) {
    if (!plant.sowingAllowed) continue;
    for (const st of plant.subtypes || []) {
      if (norm(st.name) === want) return { plant, subtype: st };
    }
  }
  return null;
}

async function findAllBatchesForRequest(sowingRequestId) {
  const reqId = new mongoose.Types.ObjectId(sowingRequestId);
  return PlantSlot.aggregate([
    { $match: { "subtypeSlots.slots.sowingBatches.sowingRequestId": reqId } },
    { $unwind: "$subtypeSlots" },
    { $unwind: "$subtypeSlots.slots" },
    { $unwind: "$subtypeSlots.slots.sowingBatches" },
    { $match: { "subtypeSlots.slots.sowingBatches.sowingRequestId": reqId } },
    {
      $project: {
        slotId: "$subtypeSlots.slots._id",
        startDay: "$subtypeSlots.slots.startDay",
        endDay: "$subtypeSlots.slots.endDay",
        plants: "$subtypeSlots.slots.sowingBatches.plantsSowed",
      },
    },
  ]);
}

async function reverseAndDeleteRequest(request) {
  const reqId = request._id;
  const batchRows = await findAllBatchesForRequest(reqId);
  let reversed = 0;
  for (const row of batchRows) {
    const qty = Number(row.plants) || Number(request.sowedQuantity) || 0;
    const r = await reverseSowBatchFromSlot(row.slotId, reqId, qty);
    reversed += r.reversed || 0;
  }
  await PlantSlot.updateMany(
    {
      $or: [
        { "subtypeSlots.slots.linkedSowingRequests": reqId },
        { "subtypeSlots.slots.sowingInProgress.sowingRequestId": reqId },
      ],
    },
    {
      $pull: {
        "subtypeSlots.$[].slots.$[].linkedSowingRequests": reqId,
        "subtypeSlots.$[].slots.$[].sowingInProgress": { sowingRequestId: reqId },
      },
    }
  );
  await SowingRequest.deleteOne({ _id: reqId });
  return { reversed, slots: batchRows.length };
}

async function alreadyInserted(row, subtypeId, sowedAt) {
  const dayStart = new Date(sowedAt);
  dayStart.setHours(0, 0, 0, 0);
  const dayEnd = new Date(sowedAt);
  dayEnd.setHours(23, 59, 59, 999);
  const firstBatch = String(row.batches?.[0]?.batch || "").replace(
    /[.*+?^${}()|[\]\\]/g,
    "\\$&"
  );
  return SowingRequest.findOne({
    subtypeId,
    sowingCompleted: true,
    sowedQuantity: row.qty,
    sowingCompletedDate: { $gte: dayStart, $lte: dayEnd },
    notes: firstBatch ? new RegExp(`${TAG}.*${firstBatch}`) : new RegExp(TAG),
  })
    .select("requestNumber")
    .lean();
}

async function insertDiaryRow(row, plants, adminId) {
  const sowedAt = parseDiaryDate(row.sow);
  const readyStr = fmtDDMMYYYY(addDays(sowedAt, READY_DAYS));
  const cmsName = canonical(row.variety);
  const resolved = resolveSubtype(cmsName, plants);
  if (!resolved) throw new Error(`NO_SUBTYPE ${row.variety} → ${cmsName}`);

  const { plant, subtype } = resolved;
  const slot = await findSlotByPlantReadyDate(plant._id, subtype._id, readyStr);
  if (!slot?.slotId) throw new Error(`NO_SLOT ${cmsName} ${readyStr}`);

  const dup = await alreadyInserted(row, subtype._id, sowedAt);
  if (dup) {
    return { skipped: true, requestNumber: dup.requestNumber, slot: slot.startDay };
  }

  const product = await Product.findOne({
    plantId: plant._id,
    subtypeId: subtype._id,
    category: { $regex: /^seeds$/i },
    isActive: true,
  })
    .select("_id name code conversionFactor primaryUnit secondaryUnit")
    .lean();

  const packets = pktTotal(row.batches);
  const lots = batchStr(row.batches);
  const seedSource = row.raising ? "RAISING" : "COMPANY";
  const packetsFromRaising = row.raising ? packets : 0;
  const packetsFromCompany = row.raising ? 0 : packets;
  const cf = Number(product?.conversionFactor) || 1;
  const notes = `${TAG} · ${row.sow} ${row.variety} → ${subtype.name} · ${fmt(row.qty)} plants · ${lots} · ${seedSource} · excess only · no orders`;

  const requestNumber = await SowingRequest.generateRequestNumber();
  const request = new SowingRequest({
    requestNumber,
    plantId: plant._id,
    plantName: plant.name,
    subtypeId: subtype._id,
    subtypeName: subtype.name,
    ...(product?._id ? { productId: product._id } : {}),
    packetsNeeded: packets,
    packetsRequested: packets,
    excessPackets: 0,
    primaryUnit: product?.primaryUnit,
    secondaryUnit: product?.secondaryUnit,
    conversionFactor: cf,
    unitName: "packets",
    status: "issued",
    requestedBy: adminId,
    issuedBy: adminId,
    issuedDate: sowedAt,
    notes,
    linkedSlotIds: [slot.slotId],
    linkedOrderIds: [],
    isExcessiveSowing: true,
    seedSource,
    packetsFromCompany,
    packetsFromRaising,
    raisingIntakeIds: [],
    packetsIssued: packetsFromCompany,
    packetsUsed: packets,
    packetsReturned: 0,
    sowedQuantity: row.qty,
    laboursLadies: 0,
    laboursGents: 0,
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
    packetsUsed: packets,
    requestNumber,
    linkedOrderIds: [],
    isExcessiveSowing: true,
    shedName: "Office",
    sowedAt,
    plantReadyDays: READY_DAYS,
    resolveByReadyDate: true,
    userId: adminId,
  });

  pushEvent(request, {
    type: "SOW_COMPLETED",
    by: adminId,
    quantity: row.qty,
    unit: "plants",
    message: `Diary sow: ${fmt(row.qty)} plants, ${packets} pkt (no inventory, no orders)`,
    meta: {
      tag: TAG,
      adminBypass: true,
      excessOnly: true,
      seedSource,
      batches: row.batches,
      plantReadyDays: READY_DAYS,
      plantReadyDate: slotResult.plantReadyDate || readyStr,
      appliedSlotId: slotResult.appliedSlotId
        ? String(slotResult.appliedSlotId)
        : String(slot.slotId),
    },
  });
  if (packets > 0) {
    pushEvent(request, {
      type: "PACKETS_USED",
      by: adminId,
      quantity: packets,
      unit: "pkt",
      message: `${packets} packets recorded · ${lots} (inventory not deducted)`,
      meta: { adminBypass: true, batches: row.batches },
    });
  }

  await request.save();

  return {
    skipped: false,
    requestNumber,
    plant: plant.name,
    subtype: subtype.name,
    slot: slot.startDay,
    ready: readyStr,
    packets,
    lots,
    seedSource,
    product: product?.code || null,
  };
}

async function main() {
  console.log(APPLY ? "=== APPLY diary sow on PROD ===" : "=== DRY RUN (no writes) ===");
  console.log("Orders: NOT marked, NOT unmarked");
  console.log("Raising intakes / inventory: NOT touched\n");

  await mongoose.connect(process.env.PROD_MONGO_URL);

  const existing = await SowingRequest.find({})
    .select("requestNumber plantName subtypeName sowedQuantity packetsUsed sowingCompleted seedSource")
    .lean();
  const legacy = await Sowing.find({}).select("plantName subtypeName sowingDate totalQuantitySowed").lean();

  console.log(`Existing SowingRequest: ${existing.length}`);
  for (const r of existing) {
    console.log(
      `  ${r.requestNumber} · ${r.plantName}/${r.subtypeName} · ${fmt(r.sowedQuantity)} plants · ${r.packetsUsed || 0} pkt · ${r.seedSource || ""}`
    );
  }
  console.log(`Legacy Sowing: ${legacy.length}`);
  for (const s of legacy) {
    console.log(`  ${s.plantName}/${s.subtypeName} · ${s.sowingDate} · ${fmt(s.totalQuantitySowed)}`);
  }
  console.log();

  if (!APPLY) {
    console.log(`Would delete ${existing.length} SowingRequest + ${legacy.length} legacy Sowing, then insert ${ROWS.length} diary rows as excess.`);
    console.log("Re-run with --apply to write PROD.");
    await mongoose.disconnect();
    return;
  }

  const admin =
    (await mongoose.connection.collection("users").findOne({ role: "SUPER_ADMIN" })) ||
    (await mongoose.connection.collection("users").findOne({}));
  if (!admin?._id) throw new Error("No admin user");

  console.log("── 1) Reverse slots + delete existing sowing entries ──");
  let reversedPlants = 0;
  for (const r of existing) {
    const out = await reverseAndDeleteRequest(r);
    reversedPlants += out.reversed;
    console.log(`  deleted ${r.requestNumber} · reversed ${fmt(out.reversed)} plants on ${out.slots} slot(s)`);
  }
  const legacyDel = await Sowing.deleteMany({});
  console.log(`  deleted legacy Sowing: ${legacyDel.deletedCount}`);
  console.log(`  slot plants reversed: ${fmt(reversedPlants)}\n`);

  const plants = await PlantCms.find({ sowingAllowed: true })
    .select("name sowingAllowed subtypes")
    .lean();

  console.log("── 2) Insert 49 diary rows (excess only) ──");
  const summary = [];
  for (let i = 0; i < ROWS.length; i++) {
    const row = ROWS[i];
    try {
      const result = await insertDiaryRow(row, plants, admin._id);
      summary.push({ idx: i + 1, variety: row.variety, qty: row.qty, ok: true, ...result });
      console.log(
        `  #${String(i + 1).padStart(2)} ${result.skipped ? "SKIP" : "OK"} ${row.sow} ${row.variety} → ${result.subtype} ${result.slot} ${result.requestNumber} ${result.lots || ""}`
      );
    } catch (e) {
      summary.push({ idx: i + 1, variety: row.variety, qty: row.qty, ok: false, error: e.message });
      console.error(`  #${String(i + 1).padStart(2)} FAIL ${row.sow} ${row.variety}: ${e.message}`);
      throw e;
    }
  }

  const ok = summary.filter((s) => s.ok && !s.skipped);
  const skipped = summary.filter((s) => s.skipped);
  console.log(`\nInserted ${ok.length} · skipped ${skipped.length} · failed 0`);
  console.log(`Plants inserted: ${fmt(ok.reduce((s, r) => s + r.qty, 0))}`);
  console.log("Orders untouched.");

  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

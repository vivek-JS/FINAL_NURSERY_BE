/**
 * Apply Jul-2026 WhatsApp/sheet sow rows on PROD (admin-direct-sow logic).
 * Bhujang / Bhjang → Bahubali Plus
 *
 *   node scripts/apply-sheet-sows-prod.mjs           # dry-run
 *   node scripts/apply-sheet-sows-prod.mjs --apply   # write PROD
 */
import mongoose from "mongoose";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import Product from "../models/product.model.js";
import PlantCms from "../models/plantCms.model.js";
import Order from "../models/order.model.js";
import SowingRequest from "../models/sowingRequest.model.js";
import {
  parseNum,
  pushEvent,
  applyPlantsToLinkedSlots,
  markOrdersSowed,
  recordExcessPlantsOnSlot,
} from "../controllers/sowingCompleteHelpers.js";
import {
  parseLocalDate,
  fmtDDMMYYYY,
  findSlotByPlantReadyDate,
} from "../controllers/sowingSlotReadyHelpers.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "..", ".env") });

const APPLY = process.argv.includes("--apply");
const TAG = "sheet-sow-prod-jul2026";

const SHEET_ROWS = [
  { sowDay: "27-Jul-2026", variety: "Simbha", plants: 18270, batch: "21046327", ready: "9/26/26", packets: "18 pkt" },
  { sowDay: "27-Jul-2026", variety: "melody", plants: 10017, batch: "2601461", ready: "28-03-2027", packets: "8 pkt", note: "Farmer seed" },
  { sowDay: "27-Jul-2026", variety: "melody", plants: 22176, batch: "2602506", ready: "21/03/27", packets: "18 pkt", note: "Farmer seed" },
  { sowDay: "27-Jul-2026", variety: "melody", plants: 12348, batch: "2602559", ready: "21/03/27", packets: "09 pkt" },
  { sowDay: "27-Jul-2026", variety: "Singham", plants: 20160, batch: "R50270-522/1/2", ready: "3/25/27", packets: "17pkt" },
  { sowDay: "28-Jul-2026", variety: "Impact", plants: 15750, batch: "35438001004", ready: "3/10/27", packets: "16 pkt" },
  { sowDay: "28-Jul-2026", variety: "Bhujang +", plants: 10458, batch: "SNX-2006", ready: "3/13/27", packets: "8 pkt", note: "Farmer seed" },
  { sowDay: "28-Jul-2026", variety: "Shivaji", plants: 105336, batch: "25227", ready: "4/8/27", packets: "80 pkt", note: "Farmer seed" },
  { sowDay: "28-Jul-2026", variety: "Red King", plants: 47124, batch: "GRB-JLN-261", ready: "1/31/27", packets: "45 Pkt" },
];

const VARIETY_ALIASES = {
  "bhujang +": "bahubali plus",
  bhujang: "bahubali plus",
  "bhujang+": "bahubali plus",
  bhjang: "bahubali plus",
  "bhjang +": "bahubali plus",
  "red king": "redking",
};

function parseSheetDate(raw) {
  const s = String(raw || "").trim();
  if (!s) return null;
  if (/^\d{2}-\d{2}-\d{4}$/.test(s)) return parseLocalDate(s);
  const slash = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (slash) {
    let y = parseInt(slash[3], 10);
    if (y < 100) y += 2000;
    const a = parseInt(slash[1], 10);
    const b = parseInt(slash[2], 10);
    let month;
    let day;
    if (a > 12) {
      day = a;
      month = b;
    } else if (b > 12) {
      month = a;
      day = b;
    } else {
      month = a;
      day = b;
    }
    return parseLocalDate(
      `${y}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`
    );
  }
  return parseLocalDate(s);
}

function parseSowDay(raw) {
  const m = String(raw).match(/^(\d+)-([A-Za-z]+)-(\d+)$/);
  if (!m) return parseSheetDate(raw);
  const months = {
    Jan: "01", Feb: "02", Mar: "03", Apr: "04", May: "05", Jun: "06",
    Jul: "07", Aug: "08", Sep: "09", Oct: "10", Nov: "11", Dec: "12",
  };
  return parseLocalDate(`${m[3]}-${months[m[2].slice(0, 3)] || "07"}-${String(m[1]).padStart(2, "0")}`);
}

function parsePkt(raw) {
  const m = String(raw || "").match(/(\d+(?:\.\d+)?)/);
  return m ? Number(m[1]) : 0;
}

function ymdFromDate(d) {
  if (!d) return "";
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function resolveSubtype(variety, plant) {
  const raw = String(variety || "").trim().toLowerCase();
  const aliased = VARIETY_ALIASES[raw] || raw;
  const vNorm = aliased.replace(/[^a-z0-9]+/g, "");
  for (const st of plant.subtypes || []) {
    const name = String(st.name || "").toLowerCase();
    const nameNorm = name.replace(/[^a-z0-9]+/g, "");
    if (name === aliased || nameNorm === vNorm || name.includes(aliased) || aliased.includes(name)) {
      return st;
    }
  }
  return null;
}

async function resolveSeedProduct(plantId, subtypeId) {
  return Product.findOne({
    plantId: new mongoose.Types.ObjectId(plantId),
    subtypeId: new mongoose.Types.ObjectId(subtypeId),
    category: { $regex: /^seeds$/i },
    isActive: true,
  })
    .select("_id conversionFactor primaryUnit secondaryUnit")
    .lean();
}

async function findOrdersForReadyDate(plantId, subtypeId, readyDate) {
  const dayStart = new Date(readyDate);
  dayStart.setHours(0, 0, 0, 0);
  dayStart.setDate(dayStart.getDate() - 4);
  const dayEnd = new Date(readyDate);
  dayEnd.setHours(23, 59, 59, 999);
  dayEnd.setDate(dayEnd.getDate() + 4);
  return Order.find({
    plantName: plantId,
    plantSubtype: subtypeId,
    sowingDone: { $ne: true },
    orderStatus: { $nin: ["CANCELLED", "TEMPORARY_CANCELLED", "REJECTED", "DELETED"] },
    deliveryDate: { $gte: dayStart, $lte: dayEnd },
  })
    .select("_id orderId numberOfPlants additionalPlants bookingSlot")
    .sort({ deliveryDate: 1, orderId: 1 })
    .lean();
}

async function alreadyApplied(row, subtypeId, sowedAt) {
  const dayStart = new Date(sowedAt);
  dayStart.setHours(0, 0, 0, 0);
  const dayEnd = new Date(sowedAt);
  dayEnd.setHours(23, 59, 59, 999);
  return SowingRequest.findOne({
    subtypeId,
    sowingCompleted: true,
    sowedQuantity: row.plants,
    sowingCompletedDate: { $gte: dayStart, $lte: dayEnd },
    completionNotes: new RegExp(row.batch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
  })
    .select("requestNumber")
    .lean();
}

async function submitRow(row, plant, subtype, adminId) {
  const sowedAt = parseSowDay(row.sowDay);
  const readyDate = parseSheetDate(row.ready);
  if (!sowedAt || !readyDate) throw new Error("bad dates");

  const readyStr = fmtDDMMYYYY(readyDate);
  const readyYmd = ymdFromDate(readyDate);
  const plantReadyDays = Math.round((readyDate - sowedAt) / 86400000);
  if (plantReadyDays < 0) throw new Error("ready before sow");

  const slot = await findSlotByPlantReadyDate(plant._id, subtype._id, readyStr);
  if (!slot?.slotId) throw new Error(`no slot for ${readyStr}`);

  const orders = await findOrdersForReadyDate(plant._id, subtype._id, readyDate);
  const isExcessOnly = !orders.length;
  const orderObjectIds = orders.map((o) => o._id);

  let slotIds = [...new Set(orders.map((o) => String(o.bookingSlot)).filter(Boolean))].map(
    (id) => new mongoose.Types.ObjectId(id)
  );
  if (isExcessOnly || !slotIds.length) {
    slotIds = [slot.slotId];
  }

  const plantsSowed = row.plants;
  const packetsUsed = parsePkt(row.packets);
  const product = await resolveSeedProduct(plant._id, subtype._id);
  const cf = Number(product?.conversionFactor) || 1;
  const pktRecord = packetsUsed > 0 ? packetsUsed : product && cf > 0 ? Math.ceil(plantsSowed / cf) : 0;

  const batchNumber = String(row.batch || "").trim();
  const noteExtra = row.note ? ` · ${row.note}` : "";
  const notes = `${TAG} · Sheet ${row.variety} → ${subtype.name} · sow ${fmtDDMMYYYY(sowedAt)} · batch ${batchNumber}${noteExtra}`;

  const requestNumber = await SowingRequest.generateRequestNumber();
  const request = new SowingRequest({
    requestNumber,
    plantId: plant._id,
    plantName: plant.name,
    subtypeId: subtype._id,
    subtypeName: subtype.name,
    ...(product?._id ? { productId: product._id } : {}),
    packetsNeeded: pktRecord,
    packetsRequested: pktRecord,
    excessPackets: 0,
    conversionFactor: cf,
    unitName: "packets",
    status: "issued",
    requestedBy: adminId,
    issuedBy: adminId,
    issuedDate: sowedAt,
    notes,
    linkedSlotIds: slotIds,
    linkedOrderIds: orderObjectIds,
    isExcessiveSowing: isExcessOnly,
    seedSource: row.note?.toLowerCase().includes("farmer") ? "RAISING" : "COMPANY",
    packetsFromCompany: pktRecord,
    packetsFromRaising: 0,
    packetsIssued: pktRecord,
    packetsUsed: pktRecord,
    packetsReturned: 0,
    sowedQuantity: plantsSowed,
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

  const slotResult = await applyPlantsToLinkedSlots(request, plantsSowed, {
    packetsUsed: pktRecord,
    requestNumber,
    linkedOrderIds: orderObjectIds,
    isExcessiveSowing: isExcessOnly,
    shedName: "Office",
    sowedAt,
    plantReadyDays,
    resolveByReadyDate: true,
    userId: adminId,
  });

  const orderResult = await markOrdersSowed(request, {
    sowedAt,
    plantsSowed,
    plantReadyDays,
    orderIds: orderObjectIds,
  });

  const excessPlants = Math.max(0, Number(orderResult.remainingUncovered) || 0);
  const orderCoveredPlants = Math.max(0, plantsSowed - excessPlants);

  if (slotResult.appliedSlotId) {
    await recordExcessPlantsOnSlot(
      slotResult.appliedSlotId,
      request._id,
      excessPlants,
      orderCoveredPlants,
      orderResult.markedIds || orderObjectIds
    );
  }

  pushEvent(request, {
    type: "SOW_COMPLETED",
    by: adminId,
    quantity: plantsSowed,
    unit: "plants",
    message: `Sheet sow: ${plantsSowed} plants, ${pktRecord} pkt`,
    meta: {
      tag: TAG,
      batchNumber,
      readyDate: readyYmd,
      plantReadyDays,
      appliedSlotId: slotResult.appliedSlotId ? String(slotResult.appliedSlotId) : null,
      orderCoveredPlants,
      excessPlants,
    },
  });

  if (orderResult.marked) {
    pushEvent(request, {
      type: "ORDERS_MARKED_SOWED",
      by: adminId,
      quantity: orderResult.marked,
      unit: "orders",
      message: `${orderResult.marked} orders marked`,
    });
  }

  await request.save();

  return {
    requestNumber,
    subtypeName: subtype.name,
    readyDate: readyStr,
    appliedSlotId: slotResult.appliedSlotId ? String(slotResult.appliedSlotId) : null,
    orderCoveredPlants,
    excessPlants,
    ordersMarked: orderResult.marked,
  };
}

async function main() {
  console.log(APPLY ? "APPLY sheet sows — PROD" : "DRY-RUN sheet sows — PROD");
  console.log("Bhujang/Bhjang → Bahubali Plus\n");

  await mongoose.connect(process.env.PROD_MONGO_URL);
  const admin =
    (await mongoose.connection.collection("users").findOne({ role: "SUPER_ADMIN" })) ||
    (await mongoose.connection.collection("users").findOne({}));
  if (!admin) throw new Error("No admin user");

  const plant = await PlantCms.findById("691054dffba6fb380f8d57b3")
    .select("name subtypes sowingAllowed")
    .lean();
  if (!plant?.sowingAllowed) throw new Error("Watermelon not sowing-allowed");

  const summary = [];

  for (const row of SHEET_ROWS) {
    const subtype = resolveSubtype(row.variety, plant);
    if (!subtype) {
      summary.push({ variety: row.variety, ok: false, error: "subtype not found" });
      continue;
    }

    const sowedAt = parseSowDay(row.sowDay);
    const dup = await alreadyApplied(row, subtype._id, sowedAt);
    if (dup) {
      summary.push({
        variety: row.variety,
        subtype: subtype.name,
        ok: true,
        skipped: true,
        requestNumber: dup.requestNumber,
      });
      continue;
    }

    if (!APPLY) {
      const readyDate = parseSheetDate(row.ready);
      const slot = await findSlotByPlantReadyDate(
        plant._id,
        subtype._id,
        fmtDDMMYYYY(readyDate)
      );
      summary.push({
        variety: row.variety,
        mapsTo: subtype.name,
        plants: row.plants,
        batch: row.batch,
        ready: fmtDDMMYYYY(readyDate),
        slot: slot?.startDay || "MISSING",
        ok: Boolean(slot?.slotId),
        dryRun: true,
      });
      continue;
    }

    try {
      const result = await submitRow(row, plant, subtype, admin._id);
      summary.push({ variety: row.variety, mapsTo: subtype.name, ok: true, ...result });
      console.log("OK", row.variety, "→", subtype.name, result.requestNumber, result.readyDate);
    } catch (e) {
      summary.push({ variety: row.variety, mapsTo: subtype.name, ok: false, error: e.message });
      console.error("FAIL", row.variety, e.message);
    }
  }

  console.log("\n=== SUMMARY ===");
  console.log(JSON.stringify(summary, null, 2));
  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

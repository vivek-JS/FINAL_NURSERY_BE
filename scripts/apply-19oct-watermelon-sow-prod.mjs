/**
 * 19 Oct 2026 watermelon diary: cancel hung packing requests, create sow entries, mark orders sown.
 *   node scripts/apply-19oct-watermelon-sow-prod.mjs
 *   node scripts/apply-19oct-watermelon-sow-prod.mjs --apply
 */
import dotenv from "dotenv";
import mongoose from "mongoose";
import path from "path";
import { fileURLToPath } from "url";
import PlantCms from "../models/plantCms.model.js";
import Product from "../models/product.model.js";
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
  toSowYmd,
} from "../controllers/sowingSlotReadyHelpers.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "..", ".env") });

const APPLY = process.argv.includes("--apply");
const TAG = "diary-19oct2026-watermelon";
const HUNG_NUMBERS = ["SR202610180006", "SR202610180005", "SR202610190014"];

const ROWS = [
  { n: 2, orderId: 4216, plants: 12978, packets: 0, raising: false, excessOnly: false },
  { n: 3, orderId: 4109, plants: 7812, packets: 0, raising: false, excessOnly: false },
  { n: 4, orderId: 4133, plants: 13860, packets: 12, raising: false, excessOnly: false },
  { n: 5, orderId: 4215, plants: 20196, packets: 20, raising: true, excessOnly: false },
  { n: 6, orderId: null, plants: 105462, packets: 100, raising: false, excessOnly: true, subtypeName: "Prachand" },
];

const sowedAt = parseLocalDate("2026-10-19");
const plantReadyDays = 18;
const labour = { ladies: 14, gents: 2, start: "10:00", end: "16:55", minutes: 415 };

async function resolveSeedProduct(plantId, subtypeId) {
  return Product.findOne({
    plantId: new mongoose.Types.ObjectId(plantId),
    subtypeId: new mongoose.Types.ObjectId(subtypeId),
    category: { $regex: /^seeds$/i },
    isActive: true,
  })
    .select("_id name conversionFactor primaryUnit secondaryUnit")
    .lean();
}

async function cancelHung(adminId) {
  const hung = await SowingRequest.find({
    requestNumber: { $in: HUNG_NUMBERS },
    sowingCompleted: { $ne: true },
    status: { $nin: ["cancelled"] },
  });
  const out = [];
  for (const r of hung) {
    if (r.outwardId && r.packetsIssued > 0) {
      out.push({ requestNumber: r.requestNumber, skipped: true, reason: "has issued stock" });
      continue;
    }
    if (APPLY) {
      r.status = "cancelled";
      r.sowingInProgress = false;
      r.cancelledBy = adminId;
      r.cancelledDate = new Date();
      r.cancellationReason = `${TAG} · hung packing cancelled; order sown from diary`;
      await r.save();
    }
    out.push({
      requestNumber: r.requestNumber,
      subtypeName: r.subtypeName,
      cancelled: APPLY,
      linked: (r.linkedOrderIds || []).length,
    });
  }
  return out;
}

async function applyRow({ plant, adminId, row }) {
  let order = null;
  let subtype = null;
  if (row.orderId) {
    order = await Order.findOne({ orderId: row.orderId })
      .select("_id orderId numberOfPlants additionalPlants plantSubtype bookingSlot sowingDone orderStatus")
      .lean();
    if (!order) throw new Error(`order ${row.orderId} missing`);
    if (order.sowingDone) {
      return { n: row.n, skipped: true, reason: `order ${row.orderId} already sown` };
    }
    subtype = (plant.subtypes || []).find((s) => String(s._id) === String(order.plantSubtype));
  } else {
    subtype = (plant.subtypes || []).find(
      (s) => String(s.name).toLowerCase() === String(row.subtypeName).toLowerCase()
    );
  }
  if (!subtype) throw new Error(`subtype missing for row ${row.n}`);

  const product = await resolveSeedProduct(plant._id, subtype._id);
  const cf = Number(product?.conversionFactor) || 1;
  const pktRecord = Math.max(0, Number(row.packets) || 0);
  const seedSource = row.raising ? "RAISING" : "COMPANY";
  const packetsFromRaising = row.raising ? pktRecord : 0;
  const packetsFromCompany = row.raising ? 0 : pktRecord;
  const isExcessOnly = Boolean(row.excessOnly) || !order;
  const linkedOrderObjectIds = order ? [order._id] : [];

  let slotIds = [];
  if (order?.bookingSlot) slotIds = [order.bookingSlot];
  if (!slotIds.length) {
    const ready = addReady();
    const slot = await findSlotByPlantReadyDate(plant._id, subtype._id, ready);
    if (!slot?.slotId) throw new Error(`no ready slot for ${subtype.name} ${ready}`);
    slotIds = [slot.slotId];
  }

  const notes = `${TAG} · ${subtype.name} · ${row.plants} plants${
    isExcessOnly ? " · EXCESS" : ` · order #${row.orderId}`
  }${row.raising ? " · raising" : ""}`;

  if (!APPLY) {
    return {
      n: row.n,
      dry: true,
      subtype: subtype.name,
      plants: row.plants,
      packets: pktRecord,
      seedSource,
      orderId: row.orderId,
      excessOnly: isExcessOnly,
    };
  }

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
    primaryUnit: product?.primaryUnit?._id || product?.primaryUnit,
    secondaryUnit: product?.secondaryUnit?._id || product?.secondaryUnit,
    conversionFactor: cf,
    unitName: "packets",
    status: "issued",
    requestedBy: adminId,
    issuedBy: adminId,
    issuedDate: sowedAt,
    notes,
    linkedSlotIds: slotIds,
    linkedOrderIds: linkedOrderObjectIds,
    isExcessiveSowing: isExcessOnly,
    seedSource,
    packetsFromCompany,
    packetsFromRaising,
    packetsIssued: packetsFromCompany,
    packetsUsed: pktRecord,
    packetsReturned: 0,
    raisingPacketsUsed: packetsFromRaising,
    sowedQuantity: row.plants,
    laboursLadies: labour.ladies,
    laboursGents: labour.gents,
    machineStartTime: labour.start,
    machineEndTime: labour.end,
    machineMinutes: labour.minutes,
    shedName: "Office",
    completionNotes: notes,
    completedBy: adminId,
    sowingCompleted: true,
    sowingCompletedDate: sowedAt,
    sowingInProgress: false,
    remainingSowingNeeded: 0,
    completionEvents: [],
  });

  const slotResult = await applyPlantsToLinkedSlots(request, row.plants, {
    packetsUsed: pktRecord,
    requestNumber,
    linkedOrderIds: linkedOrderObjectIds,
    isExcessiveSowing: isExcessOnly,
    shedName: "Office",
    sowedAt,
    plantReadyDays,
    resolveByReadyDate: true,
    userId: adminId,
  });

  pushEvent(request, {
    type: "SOW_COMPLETED",
    by: adminId,
    quantity: row.plants,
    unit: "plants",
    message: `Diary sow: ${row.plants} plants, ${pktRecord} pkt`,
    meta: {
      tag: TAG,
      adminBypass: true,
      excessOnly: isExcessOnly,
      sowDate: toSowYmd(sowedAt),
      plantReadyDays: slotResult.plantReadyDays ?? plantReadyDays,
      plantReadyDate: slotResult.plantReadyDate || null,
      appliedSlotId: slotResult.appliedSlotId ? String(slotResult.appliedSlotId) : null,
      laboursLadies: labour.ladies,
      laboursGents: labour.gents,
      machineStartTime: labour.start,
      machineEndTime: labour.end,
      machineMinutes: labour.minutes,
    },
  });
  if (pktRecord > 0) {
    pushEvent(request, {
      type: "PACKETS_USED",
      by: adminId,
      quantity: pktRecord,
      unit: "pkt",
      message: `${pktRecord} packets recorded (inventory not deducted — admin bypass)`,
      meta: { adminBypass: true, source: seedSource },
    });
  }

  await request.saveWithUniqueRequestNumber();

  let orderResult = { marked: 0, remainingUncovered: row.plants, markedIds: [] };
  if (!isExcessOnly) {
    orderResult = await markOrdersSowed(request, {
      sowedAt,
      plantsSowed: row.plants,
      plantReadyDays,
      orderIds: linkedOrderObjectIds,
    });
  }
  const excessPlants = Math.max(0, Number(orderResult.remainingUncovered) || 0);
  const orderCoveredPlants = Math.max(0, row.plants - excessPlants);
  if (slotResult.appliedSlotId && !isExcessOnly) {
    await recordExcessPlantsOnSlot(
      slotResult.appliedSlotId,
      request._id,
      excessPlants,
      orderCoveredPlants,
      orderResult.batchLinkedIds || orderResult.markedIds || request.linkedOrderIds || []
    );
  }
  if (orderResult.marked) {
    pushEvent(request, {
      type: "ORDERS_MARKED_SOWED",
      by: adminId,
      quantity: orderResult.marked,
      unit: "orders",
      message: `${orderResult.marked} included orders marked sowingDone`,
      meta: {
        remainingUncovered: orderResult.remainingUncovered ?? 0,
        orderCoveredPlants,
        excessPlants,
      },
    });
  }
  await request.save();

  const markedOrder = order
    ? await Order.findById(order._id).select("orderId sowingDone").lean()
    : null;
  return {
    n: row.n,
    requestNumber,
    subtype: subtype.name,
    plants: row.plants,
    packets: pktRecord,
    ordersMarked: orderResult.marked,
    excessPlants,
    orderCoveredPlants,
    orderSown: markedOrder?.sowingDone || false,
    orderId: markedOrder?.orderId || null,
    readyDate: slotResult.plantReadyDate,
  };
}

function addReady() {
  return fmtDDMMYYYY(
    (() => {
      const d = new Date(sowedAt);
      d.setHours(0, 0, 0, 0);
      d.setDate(d.getDate() + plantReadyDays);
      return d;
    })()
  );
}

await mongoose.connect(process.env.PROD_MONGO_URL);
try {
  const admin = await mongoose.connection.db.collection("users").findOne({
    _id: new mongoose.Types.ObjectId("6976c986299fa0215edc853d"),
  });
  if (!admin) throw new Error("admin missing");
  const plant = await PlantCms.findById("691054dffba6fb380f8d57b3")
    .select("name subtypes sowingAllowed")
    .lean();
  if (!plant?.sowingAllowed) throw new Error("Watermelon not sowing-allowed");

  const cancelled = await cancelHung(admin._id);
  const created = [];
  for (const row of ROWS) {
    created.push(await applyRow({ plant, adminId: admin._id, row }));
  }
  console.log(JSON.stringify({ apply: APPLY, cancelled, created }, null, 2));
} finally {
  await mongoose.disconnect();
}

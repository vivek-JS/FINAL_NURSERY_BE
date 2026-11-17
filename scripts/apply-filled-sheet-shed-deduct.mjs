/**
 * One-shot. Deduct the filled banana sheet quantities from the agreed
 * batch/shed lines and mark those orders COMPLETED.
 *
 *   node scripts/apply-filled-sheet-shed-deduct.mjs
 */
import "dotenv/config";
import fs from "fs";
import mongoose from "mongoose";
import moment from "moment";
import PlantOutward from "../models/plantOutward.model.js";
import DispatchBatch from "../models/dispatchBatch.model.js";
import Order from "../models/order.model.js";
import Dispatch from "../models/dispatch.model.js";
import { safeMongooseNumber } from "../utility/safeMongooseNumber.js";
import { computeSecondaryDispatchEligibility } from "../services/secondaryVehicleLoad.service.js";
import { recordSecondaryOutwardOnLedger } from "../services/secondaryDispatchAvailability.service.js";
import {
  recordShedActivity,
  SHED_ACTIVITY_ACTIONS,
} from "../services/shedActivity.service.js";
import {
  syncSecondaryInwardSlotStockAdd,
  subtractSecondaryInwardSlotStock,
  planDualStockOutflow,
} from "../services/secondaryShedSlotStock.service.js";
import { appendStatusChangeToUpdate } from "../utils/orderStatusAuditHelper.js";

const SHEET = "/tmp/fill-sheet.json";
const SHED = {
  rajgad: "rajgad",
  shivneri: "shivneri",
  torna: "torna",
  pratapgad: "pratapgad",
  purndar: "purandar",
  purandar: "purandar",
  devgiri: "devgiri",
};

function n(v) {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
}
function norm(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}
function idStr(v) {
  if (v == null) return "";
  return String(v._id || v);
}

function resolveBatch(batches, raw) {
  const k = norm(raw);
  if (!k || k === "0") return null;
  const exact = batches.filter((b) => norm(b.batchNumber) === k);
  if (exact.length === 1) return exact[0];
  const tail = batches.filter((b) => {
    const bn = norm(b.batchNumber);
    return bn.endsWith(k) && bn.length <= k.length + 2;
  });
  return tail.length === 1 ? tail[0] : null;
}

function positiveLines(linesBy, batchId, shedKey) {
  return (linesBy.get(String(batchId)) || [])
    .filter((l) => l.avail > 0 && (!shedKey || l.key.includes(shedKey)))
    .sort((a, b) => b.avail - a.avail);
}

function takeFrom(lines, plants, meta) {
  let need = plants;
  const parts = [];
  for (const line of lines) {
    if (need < 1) break;
    if (line.avail < 1) continue;
    const take = Math.min(line.avail, need);
    line.avail -= take;
    need -= take;
    parts.push({ ...meta, inwardId: line.id, shed: line.shed, size: line.size, plants: take });
  }
  if (need > 0) {
    throw new Error(
      `Not enough stock for ${meta.batchNumber} ${meta.shedKey || ""}: short ${need}`
    );
  }
  return parts;
}

async function buildPlan(db) {
  const sheet = JSON.parse(fs.readFileSync(SHEET, "utf8"));
  const batches = await DispatchBatch.find().select("batchNumber secondaryPlantReadyDays").lean();
  const orders = await Order.find({ orderId: { $in: sheet.map((r) => r.order) } })
    .select("orderId orderStatus numberOfPlants additionalPlants returnedPlants damagedPlants")
    .lean();
  const byNum = new Map(orders.map((o) => [o.orderId, o]));
  const outwards = await db.collection("plantoutwards").find(
    { "secondaryOutward.linkedOrderId": { $in: orders.map((o) => o._id) } },
    { projection: { secondaryOutward: 1 } }
  ).toArray();
  const alreadyBy = new Map();
  for (const po of outwards) {
    for (const row of po.secondaryOutward || []) {
      const oid = idStr(row.linkedOrderId);
      alreadyBy.set(oid, (alreadyBy.get(oid) || 0) + (n(row.totalQuantity) || n(row.numberOfPlants)));
    }
  }

  const moves = [];
  for (const row of sheet) {
    const o = byNum.get(row.order);
    const batch = resolveBatch(batches, row.batch);
    const shedKey = SHED[norm(row.shed)] || "";
    if (!o || !batch || !shedKey) continue;
    const want = Math.max(0, row.plants - n(o.returnedPlants) - n(o.damagedPlants));
    const gap = Math.max(0, want - (alreadyBy.get(String(o._id)) || 0));
    if (gap < 1) continue;
    moves.push({
      order: row.order,
      orderId: o._id,
      batchNumber: batch.batchNumber,
      batchId: String(batch._id),
      shedKey,
      gap,
    });
  }

  const batchIds = [...new Set(moves.map((m) => m.batchId))];
  const sbOld = batches.find((b) => b.batchNumber === "SB Old");
  const sb178 = batches.find((b) => b.batchNumber === "SB 178");
  const sb318 = batches.find((b) => b.batchNumber === "SB 318");
  for (const extra of [sbOld, sb178, sb318]) {
    if (extra && !batchIds.includes(String(extra._id))) batchIds.push(String(extra._id));
  }
  const stockDocs = await db.collection("plantoutwards").find(
    { batchId: { $in: batchIds.map((x) => new mongoose.Types.ObjectId(x)) } },
    { projection: { batchId: 1, secondaryInward: 1 } }
  ).toArray();
  const ledgers = await db.collection("secondarydispatchavailabilities").find(
    { dispatchBatchId: { $in: batchIds.map((x) => new mongoose.Types.ObjectId(x)) } },
    { projection: { fifoLines: 1 } }
  ).toArray();
  const fifoByInward = new Map();
  for (const doc of ledgers) {
    for (const line of doc.fifoLines || []) {
      fifoByInward.set(String(line.secondaryInwardId), n(line.remainingPlants));
    }
  }
  const linesBy = new Map();
  for (const po of stockDocs) {
    linesBy.set(
      String(po.batchId),
      (po.secondaryInward || []).map((si) => {
        const avail = n(si.availableQuantity);
        const fifo = fifoByInward.has(String(si._id)) ? fifoByInward.get(String(si._id)) : 0;
        return {
          id: String(si._id),
          shed: String(si.pollyhouse || ""),
          key: norm(si.pollyhouse),
          avail: Math.min(avail, fifo),
          size: si.size,
        };
      })
    );
  }

  const sb178Id = String(sb178._id);
  const tornaOrders = moves
    .filter((m) => m.batchId === sb178Id && m.shedKey === "torna")
    .sort((a, b) => b.gap - a.gap);
  const capLines = positiveLines(linesBy, sb178Id, "torna");
  const cap = capLines.reduce((s, l) => s + l.avail, 0);
  let used = 0;
  const overflow = [];
  const byOrder = new Map();
  function addParts(orderNum, orderId, parts) {
    const row = byOrder.get(orderNum) || { order: orderNum, orderId, plants: 0, parts: [] };
    row.parts.push(...parts);
    row.plants += parts.reduce((s, p) => s + p.plants, 0);
    byOrder.set(orderNum, row);
  }

  for (const m of tornaOrders) {
    const meta = { batchNumber: "SB 178", batchId: sb178Id, shedKey: "torna" };
    if (used + m.gap <= cap) {
      addParts(m.order, m.orderId, takeFrom(capLines, m.gap, meta));
      used += m.gap;
    } else if (used < cap) {
      const stay = cap - used;
      addParts(m.order, m.orderId, takeFrom(capLines, stay, meta));
      overflow.push({ ...m, gap: m.gap - stay });
      used += stay;
    } else {
      overflow.push(m);
    }
  }

  const oldLines = positiveLines(linesBy, String(sbOld._id), "");
  const oldMeta = { batchNumber: "SB Old", batchId: String(sbOld._id), shedKey: "pratapgad" };
  for (const m of overflow) {
    addParts(m.order, m.orderId, takeFrom(oldLines, m.gap, oldMeta));
  }
  const order4367 = moves.find((m) => m.order === 4367);
  addParts(4367, order4367.orderId, takeFrom(oldLines, order4367.gap, oldMeta));

  const order4139 = moves.find((m) => m.order === 4139);
  const pLines = positiveLines(linesBy, String(sb318._id), "pratapgad");
  addParts(
    4139,
    order4139.orderId,
    takeFrom(pLines, order4139.gap, {
      batchNumber: "SB 318",
      batchId: String(sb318._id),
      shedKey: "pratapgad",
    })
  );

  const skip = new Set([4367, 4139, ...tornaOrders.map((m) => m.order)]);
  for (const m of moves) {
    if (skip.has(m.order)) continue;
    const lines = positiveLines(linesBy, m.batchId, m.shedKey);
    addParts(
      m.order,
      m.orderId,
      takeFrom(lines, m.gap, {
        batchNumber: m.batchNumber,
        batchId: m.batchId,
        shedKey: m.shedKey,
      })
    );
  }

  const plans = [...byOrder.values()];
  const total = plans.reduce((s, p) => s + p.plants, 0);
  if (plans.length !== 56 || total !== 112342) {
    throw new Error(`Plan changed: ${plans.length} orders, ${total} plants (expected 56 / 112342 after the first 6)`);
  }
  const badSize = plans.flatMap((p) => p.parts).find((part) => !["R1", "R2", "R3"].includes(part.size));
  if (badSize) {
    throw new Error(`Tray size missing on ${badSize.batchNumber} ${badSize.shed} (${badSize.size})`);
  }
  return plans;
}

async function deductLine({ session, order, dispatch, batchDoc, part }) {
  const plantOutward = await PlantOutward.findOne({ batchId: batchDoc._id }).session(session);
  const si = plantOutward?.secondaryInward?.id(part.inwardId);
  if (!si) throw new Error(`Inward line missing ${part.batchNumber} ${part.inwardId}`);
  const avail = n(si.availableQuantity);
  const plantsMoving = part.plants;
  if (avail < plantsMoving) {
    throw new Error(
      `Short on ${part.batchNumber} ${si.pollyhouse}: ${avail} available, ${plantsMoving} required (order ${order.orderId})`
    );
  }
  const siPlain = si.toObject();
  const cavity = Math.max(1, Math.floor(n(siPlain.cavity) || 126));
  const fullTrays = Math.floor(plantsMoving / cavity);
  const partialPlants = plantsMoving % cavity;
  const loadedTrayCount = fullTrays + (partialPlants > 0 ? 1 : 0);
  const size = siPlain.size;
  if (!["R1", "R2", "R3"].includes(size)) {
    throw new Error(`Bad tray size on ${part.batchNumber} ${si.pollyhouse}: ${size}`);
  }
  const entry = {
    secondaryOutwardDate: new Date(),
    numberOfBottles: Math.max(1, Math.floor(n(siPlain.numberOfBottles) || 1)),
    size,
    cavity,
    numberOfTrays: loadedTrayCount,
    numberOfFullTrays: fullTrays,
    partialTrayPlants: partialPlants,
    totalQuantity: plantsMoving,
    numberOfPlants: plantsMoving,
    availableQuantity: plantsMoving,
    pollyhouse: String(siPlain.pollyhouse || part.shed || "").trim(),
    laboursEngaged: 1,
    transferStatus: "available",
    sourceSecondaryInwardId: si._id,
    linkedOrderId: order._id,
    orderLinkSnapshot: {
      orderIdNumeric: order.orderId,
      publicOrderCode: order.publicOrderCode ?? null,
      batchNumber: batchDoc.batchNumber,
      plantNameId: order.plantName,
      plantSubtypeId: order.plantSubtype,
      productOrderSnapshot: order.productOrderSnapshot || undefined,
      productName: order.productName,
      productMappingId: order.productMappingId,
    },
    deliveryCompleteDeduction: true,
  };
  if (dispatch?._id) {
    entry.linkedDispatchId = dispatch._id;
    entry.dispatchFulfillmentSnapshot = {
      transportId: dispatch.transportId,
      driverName: dispatch.driverName,
      vehicleName: dispatch.vehicleName,
      vehicleNumber: dispatch.vehicleNumber,
    };
  }

  const secondaryDays = n(safeMongooseNumber(batchDoc.secondaryPlantReadyDays));
  const dispatchElig = computeSecondaryDispatchEligibility(siPlain, secondaryDays, moment().startOf("day"));
  let loadSourceSlotId = siPlain.linkedBookingSlotId || null;
  let syncedBeforeBurn = Math.max(0, n(siPlain.slotStockSyncedPlants));
  const syncResult = await syncSecondaryInwardSlotStockAdd({
    session,
    batchId: batchDoc._id,
    secondaryInwardId: si._id,
    batchLean: batchDoc,
    siPlain,
    dispatchEligible: dispatchElig.dispatchEligible,
    force: true,
    readyPositionOnly: true,
    performedBy: undefined,
  });
  loadSourceSlotId = syncResult?.slotId || siPlain.linkedBookingSlotId || loadSourceSlotId;
  syncedBeforeBurn += syncResult?.applied ?? 0;

  const dual = planDualStockOutflow({
    availableQuantity: avail,
    slotStockSyncedPlants: syncedBeforeBurn,
    quantity: plantsMoving,
  });
  const updatedDoc = await PlantOutward.findOneAndUpdate(
    { batchId: batchDoc._id, "secondaryInward._id": si._id },
    {
      $push: {
        secondaryOutward: entry,
        "secondaryInward.$.transferHistory": {
          transferDate: new Date(),
          quantityTransferred: plantsMoving,
          remarks: `Delivery complete · order #${order.orderId}`,
        },
      },
      $set: {
        "secondaryInward.$.transferStatus": dual.newAvail === 0 ? "fully_transferred" : "partially_transferred",
        "secondaryInward.$.availableQuantity": dual.newAvail,
        "secondaryInward.$.slotStockSyncedPlants": dual.newSynced,
      },
    },
    { new: true, session, runValidators: true }
  );
  const newSo = updatedDoc?.secondaryOutward?.[updatedDoc.secondaryOutward.length - 1];
  if (!newSo?._id) throw new Error(`Outward not saved for order ${order.orderId}`);

  const subResult = await subtractSecondaryInwardSlotStock({
    session,
    batchId: batchDoc._id,
    secondaryInwardId: si._id,
    batchLean: batchDoc,
    siPlain: {
      ...siPlain,
      linkedBookingSlotId: loadSourceSlotId || null,
      slotStockSyncedPlants: dual.newSynced,
      availableQuantity: dual.newAvail,
    },
    quantity: plantsMoving,
    performedBy: undefined,
    syncedAlreadyApplied: true,
  });
  if (loadSourceSlotId && subResult?.skipped && subResult.skipped !== "no_actual_ready") {
    throw new Error(`Slot ready deduct skipped (${subResult.skipped}) for order ${order.orderId}`);
  }

  await recordSecondaryOutwardOnLedger(session, {
    dispatchBatchId: batchDoc._id,
    plantOutwardId: updatedDoc._id,
    secondaryInwardId: si._id,
    secondaryOutwardId: newSo._id,
    quantity: plantsMoving,
    performedBy: undefined,
    metadata: {
      orderId: order._id,
      orderNumber: order.orderId,
      dispatchId: dispatch?._id,
      deliveryComplete: true,
    },
  });
  await recordShedActivity({
    batchId: batchDoc._id,
    stage: "secondary_inward",
    subdocId: si._id,
    action: SHED_ACTIVITY_ACTIONS.SECONDARY_OUTWARD,
    activityName: `Delivery complete · order #${order.orderId} · ${plantsMoving} plants`,
    performedBy: undefined,
    quantity: plantsMoving,
    metadata: {
      secondaryOutwardId: newSo._id,
      linkedDispatchId: dispatch?._id,
      linkedOrderId: order._id,
      deliveryComplete: true,
    },
    session,
  });
  return { outwardId: newSo._id, plantOutwardId: updatedDoc._id, shed: entry.pollyhouse };
}

async function main() {
  const uri = process.env.PROD_MONGO_URL;
  if (!uri) throw new Error("PROD_MONGO_URL is not set");
  await mongoose.connect(uri);
  const db = mongoose.connection.db;
  const plans = await buildPlan(db);
  console.log(`plan ${plans.length} orders ${plans.reduce((s, p) => s + p.plants, 0)} plants`);

  const batchCache = new Map();
  let done = 0;
  for (const plan of plans) {
    const session = await mongoose.startSession();
    try {
      session.startTransaction();
      const order = await Order.findById(plan.orderId).session(session);
      if (!order) throw new Error(`Order missing ${plan.order}`);
      const existing = await PlantOutward.aggregate([
        { $match: { "secondaryOutward.linkedOrderId": order._id } },
        { $unwind: "$secondaryOutward" },
        { $match: { "secondaryOutward.linkedOrderId": order._id } },
        { $group: { _id: null, plants: { $sum: { $ifNull: ["$secondaryOutward.totalQuantity", "$secondaryOutward.numberOfPlants"] } } } },
      ]).session(session);
      const already = n(existing[0]?.plants);
      if (already > 0 && already < plan.plants) {
        throw new Error(`Order ${plan.order} already has a partial outward of ${already}`);
      }
      let first = null;
      if (already < plan.plants) {
        const dispatch = await Dispatch.findOne({ orderIds: order._id, isDeleted: { $ne: true } })
          .sort({ updatedAt: -1 })
          .session(session)
          .lean();
        for (const part of plan.parts) {
          let batchDoc = batchCache.get(part.batchId);
          if (!batchDoc) {
            batchDoc = await DispatchBatch.findById(part.batchId).session(session).lean();
            batchCache.set(part.batchId, batchDoc);
          }
          const saved = await deductLine({ session, order, dispatch, batchDoc, part });
          if (!first) first = { ...saved, part };
        }
      }
      const primary = plan.parts[0];
      const updateOperation = appendStatusChangeToUpdate(
        {
          $set: {
            orderStatus: "COMPLETED",
            remainingPlants: 0,
            batchNumber: primary.batchNumber,
            deliveryCompleteBatch: {
              batchNumber: primary.batchNumber,
              batchId: new mongoose.Types.ObjectId(primary.batchId),
              pollyhouse: first?.shed || primary.shed,
              secondaryInwardId: new mongoose.Types.ObjectId(primary.inwardId),
              source: "shed_stock",
              capturedAt: new Date(),
              plantsDeducted: plan.plants,
              secondaryOutwardId: first?.outwardId,
              plantOutwardId: first?.plantOutwardId,
              deductionAppliedAt: new Date(),
            },
          },
        },
        order.orderStatus,
        { reason: "sheet batch shed deduction" }
      );
      await Order.findByIdAndUpdate(order._id, updateOperation, {
        new: true,
        runValidators: true,
        session,
      });
      await session.commitTransaction();
      done += 1;
      console.log(`ok ${plan.order} ${plan.plants} ${plan.parts.map((p) => `${p.batchNumber}:${p.plants}`).join("+")}`);
    } catch (err) {
      await session.abortTransaction();
      console.error(`FAIL ${plan.order}: ${err.message || err}`);
      console.error(`stopped after ${done} orders`);
      await mongoose.disconnect();
      process.exit(1);
    } finally {
      session.endSession();
    }
  }
  console.log(`completed ${done} orders`);
  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error(err);
  try { await mongoose.disconnect(); } catch { /* ignore */ }
  process.exit(1);
});

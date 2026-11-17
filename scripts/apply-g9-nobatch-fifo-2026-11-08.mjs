/**
 * One-shot: link the 109 G9 orders dispatched after 4 Oct 2026 with no batch
 * onto current shed stock, oldest ready line first, and subtract those plants.
 *
 * Does not change order status or remainingPlants. Does not add a dispatchHistory
 * quantity (that would count the plants a second time).
 *
 *   CONFIRM_PROD=YES node scripts/apply-g9-nobatch-fifo-2026-11-08.mjs
 */
import "dotenv/config";
import mongoose from "mongoose";
import { actualDispatchLegs, actualDispatchQty } from "../utility/actualStock.js";
import PlantOutward from "../models/plantOutward.model.js";
import Dispatch from "../models/dispatch.model.js";
import DispatchBatch from "../models/dispatchBatch.model.js";
import SecondaryDispatchAvailability from "../models/secondaryDispatchAvailability.model.js";
import {
  planDualStockOutflow,
  subtractSecondaryInwardSlotStock,
} from "../services/secondaryShedSlotStock.service.js";
import { bootstrapLedgerFromPlantOutward } from "../services/secondaryDispatchAvailability.service.js";
import Order from "../models/order.model.js";
import { recordShedActivity, SHED_ACTIVITY_ACTIONS } from "../services/shedActivity.service.js";

const G9 = new mongoose.Types.ObjectId("6944c7e75845df7093731ba2");
const BANANA = new mongoose.Types.ObjectId("68fdf6d45832d541b274acfa");
const AFTER = new Date("2026-10-04T18:30:00.000Z");
const MARK = "FIFO backfill 2026-11-08 G9";
const EXPECT_ORDERS = 109;
const EXPECT_PLANTS = 309460;

const EXPECT_TAKEN = {
  "SB 128||Torna (तोरणा) (5)": 41048,
  "RB 312||Purandar (पुरंदर) (6)": 26400,
  "RB 1811||Purandar (पुरंदर) (6)": 23350,
  "SB 318||Pratapgad (प्रतापगड) (4)": 20548,
  "SB 208||Torna (तोरणा) (5)": 20528,
  "RB 510||Purandar (पुरंदर) (6)": 19734,
  "RB 19||Purandar (पुरंदर) (6)": 19640,
  "SB Mix||Devgiri (देवगिरी) (8)": 15492,
  "SB 278||Torna (तोरणा) (5)": 14836,
  "RB Mix||Shivneri ( शिवनेरी) (3)": 13300,
  "RB 19||Devgiri (देवगिरी) (8)": 12112,
  "RB 17||Devgiri (देवगिरी) (8)": 9772,
  "SB Old||Torna (तोरणा) (5)": 9171,
  "CB Mix||Kondhana (कोंढाणा) (23)": 6700,
  "SB Old||Kondhana (कोंढाणा) (23)": 6626,
  "RB 19||Pratapgad (प्रतापगड) (4)": 6556,
  "SB 178||Torna (तोरणा) (5)": 6200,
  "SB Mix||Rajgad (राजगड) (7)": 6125,
  "RB Mix||Devgiri (देवगिरी) (8)": 6042,
  "RB Mix||Pratapgad (प्रतापगड) (4)": 4000,
  "RB Mix||Purandar (पुरंदर) (6)": 3906,
  "SB 139||Rajgad (राजगड) (7)": 3188,
  "RB 38||Purandar (पुरंदर) (6)": 2520,
  "SB Old||Pratapgad (प्रतापगड) (4)": 2294,
  "CB Mix||Rajgad (राजगड) (7)": 2160,
  "RB 38||Devgiri (देवगिरी) (8)": 1780,
  "RB 510||Devgiri (देवगिरी) (8)": 1771,
  "SB Mix||Panhalgad (पन्हाळगड) (12)": 1430,
  "RB 510||Rajgad (राजगड) (7)": 1091,
  "SB Old||Rajgad (राजगड) (7)": 1004,
  "RB 19||Rajgad (राजगड) (7)": 96,
  "RB Mix||Rajgad (राजगड) (7)": 40,
};

const ist = (d) =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(d));

function allotDate(order) {
  const hist = (order.dispatchHistory || [])
    .filter((h) => h?.date)
    .sort((a, b) => new Date(a.date) - new Date(b.date));
  if (hist.length) return new Date(hist[0].date);
  const ch = (order.statusChanges || [])
    .filter((c) => c?.createdAt && ["DISPATCHED", "COMPLETED"].includes(c.newStatus))
    .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  return ch[0] ? new Date(ch[0].createdAt) : new Date("2099-01-01");
}

async function loadNoBatchOrders(db) {
  const orders = await db.collection("orders").find({
    plantSubtype: G9,
    orderStatus: { $in: ["DISPATCHED", "COMPLETED"] },
    $or: [
      { "dispatchHistory.date": { $gte: AFTER } },
      { statusChanges: { $elemMatch: { createdAt: { $gte: AFTER }, newStatus: { $in: ["DISPATCHED", "COMPLETED"] } } } },
    ],
  }).project({
    orderId: 1, orderStatus: 1, remainingPlants: 1, numberOfPlants: 1, additionalPlants: 1,
    dispatchHistory: 1, statusChanges: 1,
  }).toArray();
  const counted = orders.filter((o) => actualDispatchLegs(o, AFTER).length);
  const outwards = await db.collection("plantoutwards").aggregate([
    { $match: { "secondaryOutward.linkedOrderId": { $in: counted.map((o) => o._id) } } },
    { $unwind: "$secondaryOutward" },
    { $match: { "secondaryOutward.linkedOrderId": { $in: counted.map((o) => o._id) } } },
    { $group: { _id: "$secondaryOutward.linkedOrderId", batches: { $addToSet: "$batchId" } } },
  ]).toArray();
  const hasOut = new Set(outwards.filter((r) => (r.batches || []).some(Boolean)).map((r) => String(r._id)));
  const dispatchIds = [...new Set(counted.flatMap((o) => (o.dispatchHistory || []).map((h) => h.dispatchId).filter(Boolean).map(String)))].map((id) => new mongoose.Types.ObjectId(id));
  const dispatches = await db.collection("dispatches").find({ _id: { $in: dispatchIds } }).project({ orderDispatchDetails: 1, pickupDetails: 1 }).toArray();
  const dmap = new Map(dispatches.map((d) => [String(d._id), d]));
  function hasBatch(o) {
    if (hasOut.has(String(o._id))) return true;
    for (const h of o.dispatchHistory || []) {
      if (h.dispatchBatchId) return true;
      const d = h.dispatchId ? dmap.get(String(h.dispatchId)) : null;
      if (!d) continue;
      if ((d.pickupDetails || []).some((p) => p.batchId || p.batchNumber)) return true;
      const det = (d.orderDispatchDetails || []).find((x) => String(x.orderId) === String(o._id));
      if (det && (det.shedLoadedBatches || []).some((b) => b.batchId || b.batchNumber)) return true;
    }
    return false;
  }
  return counted.filter((o) => !hasBatch(o));
}

async function loadFifoLines() {
  const batches = await DispatchBatch.find({
    isActive: { $ne: false },
    plantSubtypeId: G9,
    $or: [{ plantCmsId: BANANA }, { plantCmsId: null }, { plantCmsId: { $exists: false } }],
  }).select("batchNumber secondaryPlantReadyDays").lean();
  const bmap = new Map(batches.map((b) => [String(b._id), b]));
  const pos = await PlantOutward.find({ batchId: { $in: batches.map((b) => b._id) } }).select("batchId secondaryInward").lean();
  const lines = [];
  for (const po of pos) {
    const b = bmap.get(String(po.batchId));
    if (!b) continue;
    const days = Number(b.secondaryPlantReadyDays) || 0;
    for (const si of po.secondaryInward || []) {
      if (si.isReturn) continue;
      if ((si.transferStatus || "available") === "fully_transferred") continue;
      const avail = Math.max(0, Math.floor(Number(si.availableQuantity) || 0));
      if (avail < 1) continue;
      const inward = si.secondaryInwardDate ? new Date(si.secondaryInwardDate) : new Date(0);
      const ready = si.expectedReadyDate ? new Date(si.expectedReadyDate) : new Date(inward.getTime() + days * 86400000);
      lines.push({
        batchId: po.batchId,
        plantOutwardId: po._id,
        secondaryInwardId: si._id,
        batch: b.batchNumber || "",
        shed: String(si.pollyhouse || "").trim() || "(no shed)",
        inward,
        ready,
        size: si.size,
        cavity: Math.max(1, Math.floor(Number(si.cavity) || 126)),
        numberOfBottles: Math.max(1, Math.floor(Number(si.numberOfBottles) || 1)),
        numberOfTrays: Math.max(1, Math.floor(Number(si.numberOfTrays) || 1)),
        avail,
        left: avail,
        synced: Math.max(0, Math.floor(Number(si.slotStockSyncedPlants) || 0)),
        linkedBookingSlotId: si.linkedBookingSlotId || null,
        sortReady: ready.getTime() || 0,
        sortInward: inward.getTime() || 0,
      });
    }
  }
  lines.sort((a, b) => a.sortReady - b.sortReady || a.sortInward - b.sortInward || a.batch.localeCompare(b.batch));
  return lines;
}

function allocate(queue, lines) {
  const slices = [];
  let cursor = 0;
  let short = 0;
  for (const order of queue) {
    let need = order.plants;
    const links = [];
    while (need > 0 && cursor < lines.length) {
      const line = lines[cursor];
      if (line.left < 1) { cursor += 1; continue; }
      const take = Math.min(line.left, need);
      line.left -= take;
      need -= take;
      const slice = { ...order, line, plants: take };
      slices.push(slice);
      links.push(slice);
      if (line.left < 1) cursor += 1;
    }
    if (need > 0) short += need;
    order.links = links;
    order.unmet = need;
  }
  return { slices, short };
}

function takenMap(lines) {
  const map = new Map();
  for (const line of lines) {
    const taken = line.avail - line.left;
    if (taken < 1) continue;
    const k = `${line.batch}||${line.shed}`;
    map.set(k, (map.get(k) || 0) + taken);
  }
  return map;
}

function assertPlan(queue, lines, short) {
  const problems = [];
  if (queue.length !== EXPECT_ORDERS) problems.push(`orders ${queue.length} != ${EXPECT_ORDERS}`);
  const plants = queue.reduce((s, o) => s + o.plants, 0);
  if (plants !== EXPECT_PLANTS) problems.push(`plants ${plants} != ${EXPECT_PLANTS}`);
  if (short !== 0) problems.push(`shortfall ${short}`);
  const got = takenMap(lines);
  for (const [k, v] of Object.entries(EXPECT_TAKEN)) {
    if (got.get(k) !== v) problems.push(`taken ${k}: got ${got.get(k) ?? 0} expected ${v}`);
  }
  for (const [k, v] of got) {
    if (EXPECT_TAKEN[k] !== v) problems.push(`extra ${k}: ${v}`);
  }
  const first = queue[0];
  const last = queue[queue.length - 1];
  if (first?.orderId !== 2154) problems.push(`first order ${first?.orderId}`);
  if (last?.orderId !== 3162) problems.push(`last order ${last?.orderId}`);
  if (problems.length) {
    const err = new Error(problems.join("\n"));
    err.planMismatch = true;
    throw err;
  }
}

async function applySlice(session, slice, seq, now) {
  const { line, plants } = slice;
  const order = slice;
  const po = await PlantOutward.findOne({ _id: line.plantOutwardId }).session(session);
  if (!po) throw new Error(`Plant outward missing ${line.plantOutwardId}`);
  const si = (po.secondaryInward || []).find((x) => String(x._id) === String(line.secondaryInwardId));
  if (!si) throw new Error(`Inward missing ${line.secondaryInwardId}`);
  const avail = Math.max(0, Math.floor(Number(si.availableQuantity) || 0));
  if (avail < plants) throw new Error(`${line.batch} ${line.shed} avail ${avail} < ${plants}`);

  const ledger = await SecondaryDispatchAvailability.findOne({ dispatchBatchId: line.batchId }).session(session);
  if (!ledger) {
    await bootstrapLedgerFromPlantOutward(session, line.batchId, null);
  }

  const dual = planDualStockOutflow({
    availableQuantity: avail,
    slotStockSyncedPlants: Math.max(0, Math.floor(Number(si.slotStockSyncedPlants) || 0)),
    quantity: plants,
  });
  const status = dual.newAvail === 0 ? "fully_transferred" : "partially_transferred";
  const remark = `${MARK} · order ${order.orderId} · ${plants}`;
  const outward = {
    secondaryOutwardDate: now,
    numberOfBottles: 1,
    size: si.size || line.size,
    cavity: Math.max(1, Math.floor(Number(si.cavity) || line.cavity)),
    numberOfTrays: 1,
    numberOfFullTrays: 0,
    partialTrayPlants: plants,
    totalQuantity: plants,
    numberOfPlants: plants,
    availableQuantity: plants,
    pollyhouse: line.shed,
    laboursEngaged: 1,
    transferStatus: "available",
    sourceSecondaryInwardId: si._id,
    linkedOrderId: order._id,
    orderLinkSnapshot: { orderId: order.orderId, orderNumber: order.orderId, backfill: MARK },
    dispatchFulfillmentSequence: seq,
  };
  if (order.dispatchId) {
    outward.linkedDispatchId = order.dispatchId;
  }

  const updated = await PlantOutward.findOneAndUpdate(
    { _id: line.plantOutwardId, "secondaryInward._id": si._id },
    {
      $push: {
        secondaryOutward: outward,
        "secondaryInward.$.transferHistory": {
          transferDate: now,
          quantityTransferred: plants,
          remarks: remark,
        },
      },
      $set: {
        "secondaryInward.$.transferStatus": status,
        "secondaryInward.$.availableQuantity": dual.newAvail,
        "secondaryInward.$.slotStockSyncedPlants": dual.newSynced,
      },
    },
    { new: true, session, runValidators: true }
  );
  if (!updated) throw new Error(`Update missed inward ${si._id}`);
  const newSo = updated.secondaryOutward[updated.secondaryOutward.length - 1];
  if (!newSo?._id) throw new Error("Outward id missing");

  const batchLean = await DispatchBatch.findById(line.batchId).select("batchNumber secondaryPlantReadyDays").session(session).lean();
  await subtractSecondaryInwardSlotStock({
    session,
    batchId: line.batchId,
    secondaryInwardId: si._id,
    batchLean,
    siPlain: {
      ...(typeof si.toObject === "function" ? si.toObject() : si),
      linkedBookingSlotId: si.linkedBookingSlotId || line.linkedBookingSlotId,
      slotStockSyncedPlants: dual.newSynced,
      availableQuantity: dual.newAvail,
    },
    quantity: plants,
    syncedAlreadyApplied: true,
  });

  const ledgerDoc = await SecondaryDispatchAvailability.findOne({ dispatchBatchId: line.batchId }).session(session);
  if (!ledgerDoc) throw new Error(`Ledger missing for ${line.batch}`);
  const fifoLine = (ledgerDoc.fifoLines || []).find((l) => String(l.secondaryInwardId) === String(si._id));
  if (!fifoLine) throw new Error(`Ledger line missing for ${line.batch} ${line.shed} ${ist(line.inward)}`);
  const prevLine = Math.max(0, Math.floor(Number(fifoLine.remainingPlants) || 0));
  const ledgerTake = Math.min(prevLine, plants);
  fifoLine.remainingPlants = prevLine - ledgerTake;
  const prevTotal = ledgerDoc.totalAvailablePlants;
  ledgerDoc.recalcTotal();
  ledgerDoc.availabilityTrail.unshift({
    action: "SUBTRACT_SECONDARY_OUTWARD",
    activityName: "FIFO backfill outward",
    quantity: ledgerTake,
    previousTotalAvailable: Math.max(0, Math.floor(Number(prevTotal) || 0)),
    newTotalAvailable: ledgerDoc.totalAvailablePlants,
    reason: ledgerTake === plants
      ? remark
      : `${remark} · ledger had ${prevLine}, shed available reduced by ${plants}`,
    plantOutwardId: updated._id,
    secondaryInwardId: si._id,
    secondaryOutwardId: newSo._id,
    metadata: { orderNumber: order.orderId, backfill: MARK, shedTake: plants, ledgerTake },
  });
  ledgerDoc.markModified("fifoLines");
  ledgerDoc.markModified("availabilityTrail");
  await ledgerDoc.save({ session });
  if (ledgerTake !== plants) {
    console.log(`ledger short ${line.batch} ${line.shed} lagwad ${ist(line.inward)}: ledger ${prevLine}, shed minus ${plants}`);
  }

  await recordShedActivity({
    batchId: line.batchId,
    stage: "secondary_inward",
    subdocId: si._id,
    action: SHED_ACTIVITY_ACTIONS.SECONDARY_OUTWARD,
    activityName: `FIFO backfill · ${plants} रोप · order ${order.orderId}`,
    quantity: plants,
    reason: remark,
    metadata: { secondaryOutwardId: newSo._id, orderNumber: order.orderId },
    session,
  });

  if (order.dispatchId) {
    await Dispatch.updateOne(
      { _id: order.dispatchId, "orderDispatchDetails.orderId": order._id },
      {
        $inc: { "orderDispatchDetails.$.shedLoadedQuantity": plants },
        $set: {
          "orderDispatchDetails.$.shedLoadedAt": now,
          "orderDispatchDetails.$.shedLoadedFromSecondary": true,
        },
        $push: {
          "orderDispatchDetails.$.shedLoadedBatches": {
            batchId: line.batchId,
            batchNumber: line.batch,
            plants,
            secondaryInwardId: si._id,
            pollyhouse: line.shed,
            loadedAt: now,
          },
        },
      },
      { session }
    );
  }

  return { outwardId: newSo._id, batch: line.batch, shed: line.shed, plants };
}

async function main() {
  if (process.env.CONFIRM_PROD !== "YES") {
    throw new Error("Refusing to write PROD without CONFIRM_PROD=YES");
  }
  const url = process.env.PROD_MONGO_URL;
  if (!url) throw new Error("PROD_MONGO_URL missing");
  await mongoose.connect(url, { serverSelectionTimeoutMS: 20000 });
  const db = mongoose.connection.db;

  const noBatch = await loadNoBatchOrders(db);
  const queue = noBatch.map((o) => {
    const hist = [...(o.dispatchHistory || [])].filter((h) => h?.dispatchId).sort((a, b) => new Date(a.date || 0) - new Date(b.date || 0));
    const afterLeg = hist.find((h) => h.date && new Date(h.date) >= AFTER);
    const leg = afterLeg || hist[0] || null;
    return {
      _id: o._id,
      orderId: o.orderId,
      status: o.orderStatus,
      remainingPlants: o.remainingPlants,
      plants: actualDispatchQty(o, AFTER),
      date: allotDate(o),
      dispatchId: leg?.dispatchId || null,
      historyLegs: (o.dispatchHistory || []).length,
    };
  }).sort((a, b) => a.date - b.date || a.orderId - b.orderId);

  const lines = await loadFifoLines();
  const { slices, short } = allocate(queue, lines);
  assertPlan(queue, lines, short);
  console.log(`plan ok: ${queue.length} orders, ${slices.length} slices, ${EXPECT_PLANTS} plants`);

  const before = new Map(queue.map((o) => [String(o._id), { status: o.status, remainingPlants: o.remainingPlants }]));
  const session = await mongoose.startSession();
  const now = new Date();
  const seqByOutward = new Map();
  let written = 0;
  try {
    session.startTransaction();
    for (const slice of slices) {
      const key = String(slice.line.plantOutwardId);
      const seq = (seqByOutward.get(key) || 0) + 1;
      seqByOutward.set(key, seq);
      await applySlice(session, slice, seq, now);
      written += slice.plants;
    }
    if (written !== EXPECT_PLANTS) throw new Error(`wrote ${written} != ${EXPECT_PLANTS}`);

    const singleBatchOrders = queue.filter((o) => {
      const batches = new Set((o.links || []).map((s) => String(s.line.batchId)));
      return o.dispatchId && o.historyLegs === 1 && batches.size === 1;
    });
    for (const order of singleBatchOrders) {
      const batchId = order.links[0].line.batchId;
      await Order.updateOne(
        { _id: order._id },
        { $set: { "dispatchHistory.$[h].dispatchBatchId": batchId } },
        {
          arrayFilters: [{ "h.dispatchId": order.dispatchId, "h.dispatchBatchId": null }],
          session,
        }
      );
    }

    await session.commitTransaction();
    console.log(`committed ${written} plants across ${slices.length} links`);
  } catch (err) {
    await session.abortTransaction();
    throw err;
  } finally {
    session.endSession();
  }

  const afterOrders = await db.collection("orders").find({ _id: { $in: queue.map((o) => o._id) } }).project({ orderStatus: 1, remainingPlants: 1, orderId: 1 }).toArray();
  const changed = afterOrders.filter((o) => {
    const prev = before.get(String(o._id));
    return prev && (prev.status !== o.orderStatus || Number(prev.remainingPlants) !== Number(o.remainingPlants));
  });
  const linked = await db.collection("plantoutwards").aggregate([
    { $unwind: "$secondaryOutward" },
    { $match: { "secondaryOutward.orderLinkSnapshot.backfill": MARK } },
    { $group: { _id: null, plants: { $sum: "$secondaryOutward.totalQuantity" }, n: { $sum: 1 }, orders: { $addToSet: "$secondaryOutward.linkedOrderId" } } },
  ]).toArray();
  console.log(JSON.stringify({
    outwardRows: linked[0]?.n || 0,
    outwardPlants: linked[0]?.plants || 0,
    ordersLinked: linked[0]?.orders?.length || 0,
    ordersWhoseStatusOrRemainingChanged: changed.map((o) => o.orderId),
  }, null, 2));
  if (changed.length || linked[0]?.plants !== EXPECT_PLANTS || linked[0]?.orders?.length !== EXPECT_ORDERS) {
    throw new Error("Post-check failed");
  }
  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error(err?.planMismatch ? err.message : err);
  try { await mongoose.disconnect(); } catch { /* ignore */ }
  process.exit(1);
});

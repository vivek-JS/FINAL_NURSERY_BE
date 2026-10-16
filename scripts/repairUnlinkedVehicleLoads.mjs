/**
 * One-time: shed loads saved while the order lookup skipped DISPATCHED orders created secondary
 * outward rows with no linkedOrderId, so the order's vehicle line kept shedLoadedQuantity 0.
 * Assign those rows to the vehicle's orders (FIFO by remaining need per plant row), update the
 * order lines + batch log, sync vehicleLoaded, and send the farmer WhatsApp for fully loaded orders.
 *
 *   node scripts/repairUnlinkedVehicleLoads.mjs            # dry run
 *   node scripts/repairUnlinkedVehicleLoads.mjs --apply
 *   node scripts/repairUnlinkedVehicleLoads.mjs --cutoff=2026-10-16T00:00:00+05:30
 */
import "dotenv/config";
import mongoose from "mongoose";
import PlantOutward from "../models/plantOutward.model.js";
import Dispatch from "../models/dispatch.model.js";
import DispatchBatch from "../models/dispatchBatch.model.js";
import Order from "../models/order.model.js";
import {
  resolvePlantRowFromDispatch,
  resolveVehicleOrderIdsForPlantRow,
  vehicleLineRemainingMap,
  takePlantsFromOrdersFifo,
  updateDispatchOrderShedLoaded,
  syncDispatchTransportStatusAfterShedChange,
} from "../services/secondaryVehicleLoad.service.js";
import {
  finalizeOrderOnShedLineLoaded,
  syncOrderVehicleLoadedFlag,
} from "../services/dispatchPostLoadFinalize.service.js";
import { ensureOrderDispatchWhatsAppOnce } from "../services/orderDispatchWhatsApp.service.js";

const APPLY = process.argv.includes("--apply");
const cutoffArg = process.argv.find((a) => a.startsWith("--cutoff="))?.split("=")[1];
const cutoff = cutoffArg
  ? new Date(cutoffArg)
  : (() => {
      const istNow = new Date(Date.now() + 5.5 * 3600 * 1000);
      const midnight = Date.UTC(istNow.getUTCFullYear(), istNow.getUTCMonth(), istNow.getUTCDate());
      return new Date(midnight - 5.5 * 3600 * 1000);
    })();

await mongoose.connect(process.env.MONGO_URL || process.env.MONGODB_URI);
console.log(`Cutoff: ${cutoff.toISOString()}  mode: ${APPLY ? "APPLY" : "DRY RUN"}`);

const vehicles = await Dispatch.find({ isDeleted: { $ne: true }, createdAt: { $gte: cutoff } })
  .select("_id transportId")
  .lean();

const batchNumberCache = new Map();
async function batchNumberOf(batchId) {
  const key = String(batchId || "");
  if (!key) return "";
  if (!batchNumberCache.has(key)) {
    const b = await DispatchBatch.findById(key).select("batchNumber").lean();
    batchNumberCache.set(key, b?.batchNumber != null ? String(b.batchNumber) : "");
  }
  return batchNumberCache.get(key);
}

const orderLabel = new Map();
async function labelOf(orderId) {
  if (!orderLabel.has(orderId)) {
    const o = await Order.findById(orderId).select("orderId publicOrderCode").lean();
    orderLabel.set(orderId, o ? `#${o.publicOrderCode || o.orderId}` : orderId);
  }
  return orderLabel.get(orderId);
}

const toMessage = new Set();
let repairedRows = 0;

for (const v of vehicles) {
  const dispatchDoc = await Dispatch.findById(v._id);
  const pos = await PlantOutward.find({ "secondaryOutward.linkedDispatchId": v._id })
    .select("_id batchId secondaryOutward")
    .lean();

  const unlinked = [];
  for (const po of pos) {
    for (const so of po.secondaryOutward || []) {
      if (String(so.linkedDispatchId || "") !== String(v._id) || so.linkedOrderId) continue;
      const qty = Number(so.totalQuantity) || 0;
      if (qty > 0) unlinked.push({ po, so, qty });
    }
  }
  if (!unlinked.length) continue;
  unlinked.sort(
    (a, b) => (Number(a.so.dispatchFulfillmentSequence) || 0) - (Number(b.so.dispatchFulfillmentSequence) || 0)
  );

  const byRow = new Map();
  for (const u of unlinked) {
    const idx = Math.max(0, Number(u.so.linkedDispatchPlantRowIndex) || 0);
    if (!byRow.has(idx)) byRow.set(idx, []);
    byRow.get(idx).push(u);
  }

  const plan = [];
  for (const [idx, rows] of byRow) {
    const row = await resolvePlantRowFromDispatch(dispatchDoc, idx);
    const orderIds = await resolveVehicleOrderIdsForPlantRow(dispatchDoc, row.plantId, row.subTypeId);
    const remaining = vehicleLineRemainingMap(dispatchDoc, orderIds);
    for (const u of rows) {
      const take = takePlantsFromOrdersFifo(u.qty, orderIds, remaining);
      plan.push({ ...u, plantRowIndex: idx, parts: take.allocations, unassigned: take.unassigned });
    }
  }

  console.log(`\nVehicle ${v.transportId || v._id}:`);
  for (const p of plan) {
    const parts = await Promise.all(
      p.parts.map(async (a) => `${await labelOf(a.orderId)}=${a.plants}`)
    );
    console.log(
      `  row ${p.plantRowIndex} · ${p.so.pollyhouse || "-"} · ${p.qty} plants -> ${parts.join(", ") || "(no order with remaining need)"}` +
        (p.unassigned ? ` · unassigned ${p.unassigned}` : "")
    );
  }

  if (!APPLY) continue;

  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const fresh = await Dispatch.findById(v._id).session(session);
    const lastLoaded = new Map();
    const touchedRows = new Set();
    for (const p of plan) {
      if (!p.parts.length) continue;
      const primary = [...p.parts].sort((a, b) => b.plants - a.plants)[0].orderId;
      await PlantOutward.updateOne(
        { _id: p.po._id },
        { $set: { "secondaryOutward.$[s].linkedOrderId": new mongoose.Types.ObjectId(primary) } },
        { arrayFilters: [{ "s._id": p.so._id }], session }
      );
      const batchNumber = await batchNumberOf(p.po.batchId);
      for (const part of p.parts) {
        const loaded = await updateDispatchOrderShedLoaded({
          session,
          dispatchDoc: fresh,
          orderId: part.orderId,
          plantsLoaded: part.plants,
          batchMeta: {
            batchId: p.po.batchId,
            batchNumber,
            secondaryInwardId: p.so.sourceSecondaryInwardId,
            pollyhouse: p.so.pollyhouse,
          },
        });
        if (loaded) lastLoaded.set(part.orderId, loaded);
      }
      touchedRows.add(p.plantRowIndex);
      repairedRows += 1;
    }
    for (const [oid, loaded] of lastLoaded) {
      await finalizeOrderOnShedLineLoaded({ session, orderId: oid, dispatchDoc: fresh, orderLoaded: loaded });
      const flag = await syncOrderVehicleLoadedFlag({ session, orderId: oid, dispatchDoc: fresh });
      if (flag?.vehicleLoaded) toMessage.add(oid);
    }
    for (const idx of touchedRows) {
      await syncDispatchTransportStatusAfterShedChange({ session, dispatchDoc: fresh, plantRowIndex: idx });
    }
    await session.commitTransaction();
  } catch (err) {
    await session.abortTransaction();
    console.error(`  FAILED vehicle ${v.transportId || v._id}:`, err?.message || err);
  } finally {
    session.endSession();
  }
}

console.log(`\nVehicles scanned: ${vehicles.length}`);
if (APPLY) {
  console.log(`Outward rows repaired: ${repairedRows}`);
  for (const oid of toMessage) {
    const r = await ensureOrderDispatchWhatsAppOnce(oid);
    console.log(`WhatsApp ${await labelOf(oid)}:`, r?.sent ? "sent" : r?.reason || (r?.alreadySent ? "already sent" : "skipped"));
  }
}

await mongoose.disconnect();

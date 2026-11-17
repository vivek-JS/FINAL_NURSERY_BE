import mongoose from "mongoose";
import PlantSlot from "../models/slots.model.js";
import Order from "../models/order.model.js";
import SowingEntry from "../models/sowingEntry.model.js";
import { applyStockFieldUpdates } from "../utility/slotStockTrail.js";
import { pushBatchChangeLog } from "../utility/sowingBatchChangeLog.js";
import { dispatchBookableFree } from "../utility/sowingBatchExcessStamp.js";
import { applyDispatchOrderPlants } from "../modules/sowingEntries/syncDispatchSowEntries.js";
import { sellablePlantsOf } from "./sowBatchStock.service.js";

const toQty = (v) => Math.max(0, Math.floor(Number(v) || 0));
const idStr = (v) => (v == null || v === "" ? "" : String(v?._id ?? v));

function setSlotAvailable(slot, delta, performedBy, remark) {
  if (!delta) return;
  const prev = Number(slot.availablePlants) || 0;
  applyStockFieldUpdates(slot, { availablePlants: Math.max(0, prev + delta) }, performedBy, remark);
}

function addSlotExcess(slot, delta) {
  if (!delta) return;
  if (!slot.excessiveSowing) slot.excessiveSowing = {};
  slot.excessiveSowing.plants = Math.max(0, (Number(slot.excessiveSowing.plants) || 0) + delta);
}

/**
 * Stock-only sow return: plants become excess on the same batch (not reserved).
 * Mirrors DISPATCH_TAKE / DISPATCH_RELEASE: updates shownExcess + changeLog.
 * Unload still uses restoreSowBatchDispatch and does not call this.
 */
function returnLogReason(reason, orderCode) {
  const why = String(reason || "").trim().slice(0, 400);
  const code = String(orderCode || "").trim();
  const head = code ? `Return from order #${code}` : "Return from order";
  return why ? `${head} · ${why}` : head;
}

export function applySowReturnToBatch({
  batch,
  slot,
  qty,
  orderId,
  orderCode,
  destShed,
  performedBy,
  dispatchId,
  secondaryOutwardId,
  reason,
}) {
  const n = toQty(qty);
  if (n < 1 || !slot) return { restored: 0, unbooked: 0 };
  setSlotAvailable(slot, n, performedBy, `Sow batch return (+${n})`);
  addSlotExcess(slot, n);

  let unbooked = 0;
  if (batch) {
    const freeBefore = dispatchBookableFree(batch, batch.sowingBufferPct);
    const coverBefore = toQty(batch.orderCoveredPlants);
    unbooked = Math.min(n, coverBefore);
    batch.orderCoveredPlants = Math.max(0, coverBefore - unbooked);
    batch.excessPlants = toQty(batch.excessPlants) + n;
    // Same formula as DISPATCH_RELEASE: leftover free grows by returned plants.
    batch.shownExcess = Math.max(0, freeBefore + n);

    if (!Array.isArray(batch.excessAllocations)) batch.excessAllocations = [];
    if (orderId) {
      let trim = n;
      for (const alloc of batch.excessAllocations) {
        if (trim <= 0) break;
        if (idStr(alloc.orderId) !== idStr(orderId)) continue;
        const t = Math.min(trim, toQty(alloc.plants));
        alloc.plants = toQty(alloc.plants) - t;
        trim -= t;
      }
      batch.excessAllocations = batch.excessAllocations.filter((a) => toQty(a.plants) > 0);
      const stillAlloc = batch.excessAllocations.some((a) => idStr(a.orderId) === idStr(orderId));
      if (!stillAlloc && toQty(batch.orderCoveredPlants) === 0) {
        batch.linkedOrderIds = (batch.linkedOrderIds || []).filter((id) => idStr(id) !== idStr(orderId));
      }
    }

    const shed = String(destShed || "").trim();
    if (shed) batch.shedName = shed;

    const code = String(orderCode || "").trim();
    const logReason = returnLogReason(reason, code);
    const at = new Date();
    pushBatchChangeLog(batch, {
      at,
      by: performedBy,
      kind: "RETURN",
      plants: n,
      coverBefore,
      coverAfter: toQty(batch.orderCoveredPlants),
      excessBefore: freeBefore,
      excessAfter: toQty(batch.shownExcess),
      orderId,
      orderCode: code,
      dispatchId,
      reason: logReason,
    });

    if (!Array.isArray(batch.dispatchLog)) batch.dispatchLog = [];
    batch.dispatchLog.push({
      at,
      by: performedBy || undefined,
      dispatchId,
      orderId,
      secondaryOutwardId,
      plants: -n,
      bucket: "RETURN",
      reason: logReason,
    });
  }

  return { restored: n, unbooked, destShed: batch?.shedName || String(destShed || "").trim() };
}

/** Plants that left a sowing entry come back onto that entry. Cover stays where it was. */
async function returnPlantsToSowingEntry({ session, batchId, qty, orderId, destShed }) {
  if (!batchId || !mongoose.isValidObjectId(batchId)) return { updated: false };
  const entry = await SowingEntry.findOne({ sourceBatchId: batchId })
    .select(
      "sourceBatchId dispatchedPlants dispatchedOrders plantsSowed destroyedPlants bufferPlants sowingBufferPct mortalityMovedToExcess excessMovedToMortality noMortalityReserve isIrrelevant"
    )
    .session(session || null);
  if (!entry) return { updated: false };
  const nextOut = Math.max(0, Math.floor(Number(entry.dispatchedPlants) || 0) - qty);
  const set = {
    dispatchedPlants: nextOut,
    remainingPlants: Math.max(0, sellablePlantsOf(entry) - nextOut),
    dispatchedOrders: applyDispatchOrderPlants(entry.dispatchedOrders, [
      { orderId, plants: -qty },
    ]),
  };
  const shed = String(destShed || "").trim();
  if (shed) set.shedName = shed;
  await SowingEntry.updateOne({ _id: entry._id }, { $set: set }, { session: session || undefined });

  if (orderId && mongoose.isValidObjectId(String(orderId))) {
    const order = await Order.findById(orderId)
      .select("sowingDispatchFrom")
      .session(session || null)
      .lean();
    if (order?.sowingDispatchFrom?.length) {
      let left = qty;
      const rows = order.sowingDispatchFrom.map((row) => ({ ...row }));
      for (let i = rows.length - 1; i >= 0 && left > 0; i -= 1) {
        if (String(rows[i].batchId || "") !== batchId) continue;
        const have = Math.max(0, Number(rows[i].plants) || 0);
        const take = Math.min(have, left);
        rows[i].plants = have - take;
        left -= take;
      }
      await Order.updateOne(
        { _id: order._id },
        { $set: { sowingDispatchFrom: rows.filter((row) => Number(row.plants) > 0) } },
        { session: session || undefined }
      );
    }
  }
  return { updated: true };
}

/** Put returned sow plants back on the sowing they left from. Old loads that took a year slot get that slot back too. */
export async function returnSowBatchDispatch({
  session,
  outward,
  plants,
  dispatchId,
  performedBy,
  destShed,
  reason,
}) {
  const qty = toQty(plants);
  if (qty < 1) return { restored: 0 };
  const slotId = idStr(outward.sowReadySlotId);
  const batchId = idStr(outward.sowingBatchId);
  const orderId = outward.linkedOrderId;
  let fromAvail = 0;
  let fromReserved = 0;
  let slotRestored = 0;

  if (slotId) {
    const plantSlot = await PlantSlot.findOne({ "subtypeSlots.slots._id": slotId }).session(session || null);
    let slot = null;
    for (const st of plantSlot?.subtypeSlots || []) {
      slot = st.slots.id(slotId);
      if (slot) break;
    }
    if (slot) {
      fromAvail = Math.min(qty, toQty(outward.sowAvailableDec));
      fromReserved = qty - fromAvail;
      const batch = batchId ? slot.sowingBatches.id(batchId) : null;
      let orderCode = "";
      if (orderId && mongoose.isValidObjectId(String(orderId))) {
        const ord = await Order.findById(orderId)
          .select("orderId publicOrderCode")
          .session(session || null)
          .lean();
        orderCode = String(ord?.publicOrderCode || ord?.orderId || "").trim();
      }
      const applied = applySowReturnToBatch({
        batch,
        slot,
        qty,
        orderId,
        orderCode,
        destShed,
        performedBy,
        dispatchId,
        secondaryOutwardId: outward._id,
        reason,
      });
      if (performedBy && mongoose.isValidObjectId(String(performedBy))) slot.setPerformer?.(performedBy);
      await plantSlot.save({ session: session || undefined, validateBeforeSave: true });
      slotRestored = applied.restored;
    }
  }

  const entry = await returnPlantsToSowingEntry({ session, batchId, qty, orderId, destShed });
  if (!slotRestored && !entry.updated) {
    return { restored: 0, skipped: "entry_not_found", fromAvail, fromReserved, slotId };
  }
  return { restored: qty, fromAvail, fromReserved, slotId, entryUpdated: entry.updated };
}

/**
 * Reassign order.farmer with orderEditHistory + OrderEvent (activity timeline).
 */
import mongoose from "mongoose";
import Order from "../models/order.model.js";
import Farmer from "../models/farmer.model.js";
import FarmerPlantOrderLedgerEntry from "../models/farmerPlantOrderLedger.model.js";
import {
  normalizeFarmerMobile,
  roundMoney,
  sortLedgerEntriesCanonical,
} from "../utils/farmerPlantOrderLedgerHelper.js";
import { emitOrderEventsFromEditHistory } from "../modules/orderEvents/index.js";
import { ORDER_DOMAINS, ORDER_EVENT_SOURCE } from "../modules/orderEvents/domain/constants.js";

async function recomputeOutstandingForCustomerMobile(customerMobile) {
  if (!customerMobile || !String(customerMobile).trim()) return;
  const col = FarmerPlantOrderLedgerEntry.collection;
  const raw = await col.find({ customerMobile: String(customerMobile).trim() }).toArray();
  const sorted = sortLedgerEntriesCanonical(raw);
  let running = 0;
  for (const doc of sorted) {
    const before = roundMoney(running);
    const d = Number(doc.debit || 0);
    const c = Number(doc.credit || 0);
    const after = roundMoney(before + d - c);
    await col.updateOne({ _id: doc._id }, { $set: { outstandingBefore: before, outstandingAfter: after } });
    running = after;
  }
}

/**
 * @param {object} params
 * @param {import("mongoose").Document|object} params.order — order doc (with _id, orderId, farmer populated or id)
 * @param {import("mongoose").Types.ObjectId|string} params.targetFarmerId
 * @param {string} [params.targetFarmerName]
 * @param {string} [params.targetMobile]
 * @param {string} [params.previousFarmerName]
 * @param {import("mongoose").Types.ObjectId|string} [params.actorId]
 * @param {string} [params.actorName]
 * @param {string} [params.notes]
 * @param {import("mongoose").ClientSession} [params.session]
 * @param {boolean} [params.clearOrderFor=true]
 * @param {boolean} [params.migrateLedger=true]
 * @param {boolean} [params.emitTimelineEvent=true]
 */
export async function reassignOrderFarmerWithAudit({
  order,
  targetFarmerId,
  targetFarmerName = "",
  targetMobile = "",
  previousFarmerName = "",
  actorId,
  actorName,
  notes,
  session,
  clearOrderFor = true,
  migrateLedger = true,
  emitTimelineEvent = true,
}) {
  if (!order?._id || !targetFarmerId) {
    throw new Error("reassignOrderFarmerWithAudit requires order and targetFarmerId");
  }

  const oldFarmerId = order.farmer?._id || order.farmer;
  if (oldFarmerId && String(oldFarmerId) === String(targetFarmerId)) {
    return { skipped: true, reason: "already_assigned" };
  }

  const oldMobileNorm = order.farmer?.mobileNumber
    ? normalizeFarmerMobile(order.farmer.mobileNumber)
    : null;
  const newMobileStr = targetMobile
    ? normalizeFarmerMobile(targetMobile)
    : null;

  const defaultNotes = `Reassigned order #${order.orderId} to ${targetFarmerName || "farmer"}${
    targetMobile ? ` (${targetMobile})` : ""
  }${previousFarmerName ? `; removed wrong farmer ${previousFarmerName}` : ""}`;

  const historyEntry = {
    field: "farmer",
    previousValue: oldFarmerId || null,
    newValue: targetFarmerId,
    notes: notes || defaultNotes,
    changedBy: actorId ? new mongoose.Types.ObjectId(String(actorId)) : undefined,
    createdAt: new Date(),
  };

  const orderUpdate = {
    $set: { farmer: targetFarmerId },
    $push: { orderEditHistory: historyEntry },
  };
  if (clearOrderFor) orderUpdate.$set.orderFor = null;

  await Order.findByIdAndUpdate(order._id, orderUpdate, { session });

  if (emitTimelineEvent) {
    await emitOrderEventsFromEditHistory(
      {
        orderDomain: ORDER_DOMAINS.PLANT,
        orderId: order._id,
        entries: [historyEntry],
        actorId,
        actorName,
        reason: historyEntry.notes,
        source: ORDER_EVENT_SOURCE.LIVE,
      },
      { session }
    );
  }

  if (migrateLedger && newMobileStr) {
    const ledgerCol = FarmerPlantOrderLedgerEntry.collection;
    await ledgerCol.updateMany(
      { orderId: order._id },
      {
        $set: {
          customerMobile: newMobileStr,
          customerName: (targetFarmerName || "").trim(),
          farmer: targetFarmerId,
        },
      }
    );

    if (oldMobileNorm && oldMobileNorm !== newMobileStr) {
      await recomputeOutstandingForCustomerMobile(oldMobileNorm);
    }
    await recomputeOutstandingForCustomerMobile(newMobileStr);
  }

  return { historyEntry, oldFarmerId, targetFarmerId };
}

/** Backfill OrderEvent from an existing orderEditHistory farmer entry (one-off / repair). */
export async function emitFarmerEditHistoryToTimeline(orderId, historyEntry, { actorName } = {}) {
  if (!orderId || !historyEntry || historyEntry.field !== "farmer") return null;
  return emitOrderEventsFromEditHistory({
    orderDomain: ORDER_DOMAINS.PLANT,
    orderId,
    entries: [historyEntry],
    actorId: historyEntry.changedBy,
    actorName,
    reason: historyEntry.notes,
    source: ORDER_EVENT_SOURCE.MIGRATION,
  });
}

export async function findOrCreateFarmer(farmerPayload, { session } = {}) {
  const mobile = Number(farmerPayload.mobileNumber);
  let query = mobile ? Farmer.findOne({ mobileNumber: mobile }) : null;
  if (query && session) query = query.session(session);
  let farmer = query ? await query : null;
  if (!farmer) {
    const [created] = await Farmer.create([farmerPayload], { session });
    farmer = created;
  } else {
    await Farmer.findByIdAndUpdate(farmer._id, { $set: farmerPayload }, { session });
    farmer = session
      ? await Farmer.findById(farmer._id).session(session)
      : await Farmer.findById(farmer._id);
  }
  return farmer;
}

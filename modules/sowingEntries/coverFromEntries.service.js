import mongoose from "mongoose";
import Order from "../../models/order.model.js";
import SowingEntry from "../../models/sowingEntry.model.js";
import SowingRequest from "../../models/sowingRequest.model.js";
import { ExcessCoverError } from "../../services/orderExcessBatchCover.service.js";
import { excessWindowCapForPlant } from "../../services/orderExcessBatchCover.service.js";
import { orderPlantsNeed } from "../../controllers/orderSowFromExcess.controller.js";
import {
  orderAlreadyCovered,
  orderCoveredFromSources,
} from "../../services/orderSowCover.plan.js";
import { collectionExcessRows, releasedPlantsForEntry } from "./collectionExcess.js";
import { normalizeEntryPicks, picksMatchNeed, planEntryTakes } from "./coverFromEntriesMath.js";

const int = (value) => Math.max(0, Math.floor(Number(value) || 0));

function oid(value) {
  const text = String(value || "").trim();
  return mongoose.Types.ObjectId.isValid(text) ? new mongoose.Types.ObjectId(text) : null;
}

function fail(code, message, status = 400) {
  return new ExcessCoverError(code, message, status);
}

async function rowsForOrder({ plantId, subtypeId, deliveryDate, releaseOrderId, windowDays, pastWindowDays }) {
  const releaseId = oid(releaseOrderId);
  const docs = await SowingEntry.find({
    plantId: oid(plantId),
    subtypeId: oid(subtypeId),
    isIrrelevant: { $ne: true },
    ...(releaseId
      ? { $or: [{ excessPlants: { $gt: 0 } }, { linkedOrderIds: releaseId }] }
      : { excessPlants: { $gt: 0 } }),
  }).lean();
  const order = releaseId
    ? await Order.findById(releaseId).select("sowingCoverSources").lean()
    : null;
  const releasedById = new Map();
  for (const doc of docs) {
    const extra = releasedPlantsForEntry(doc, order?.sowingCoverSources || []);
    if (extra > 0) releasedById.set(String(doc._id), extra);
  }
  return collectionExcessRows(docs, {
    deliveryDate,
    windowDays,
    pastWindowDays,
    releasedById,
  }).entries;
}

/** Check a new order's entry picks before the order is saved. */
export async function validateEntryCoverPicks({
  plantId,
  subtypeId,
  deliveryDate,
  need,
  picks,
  windowDays = 3,
  pastWindowDays = 12,
}) {
  const list = normalizeEntryPicks(picks);
  if (!list.length) throw fail("NO_PICKS", "Select at least one sowing to cover the order");
  if (!picksMatchNeed(list, need)) {
    const sum = list.reduce((total, pick) => total + pick.plants, 0);
    throw fail("PICKS_MISMATCH", `Selected plants (${sum}) must equal order quantity (${int(need)})`);
  }
  const cap = await excessWindowCapForPlant(plantId);
  const rows = await rowsForOrder({
    plantId,
    subtypeId,
    deliveryDate,
    windowDays: Math.min(cap, Math.max(0, int(windowDays) || 3)),
    pastWindowDays: Math.min(cap, Math.max(0, int(pastWindowDays) || 12)),
  });
  planEntryTakes(list, rows);
  return list;
}

async function takeFromEntry(entryId, orderId, fromExcess) {
  if (fromExcess < 1) {
    return SowingEntry.findById(entryId).lean();
  }
  const updated = await SowingEntry.findOneAndUpdate(
    { _id: entryId, isIrrelevant: { $ne: true }, excessPlants: { $gte: fromExcess } },
    {
      $inc: { excessPlants: -fromExcess, orderCoveredPlants: fromExcess },
      $addToSet: { linkedOrderIds: orderId },
      $push: { orderCovers: { orderId, plants: fromExcess, partial: false } },
    },
    { new: true }
  ).lean();
  return updated;
}

async function giveBack(entryId, orderId, fromExcess) {
  if (fromExcess < 1) return;
  await SowingEntry.updateOne(
    { _id: entryId },
    {
      $inc: { excessPlants: fromExcess, orderCoveredPlants: -fromExcess },
      $pull: { orderCovers: { orderId, plants: fromExcess }, linkedOrderIds: orderId },
    }
  );
}

/**
 * Cover an order from sowing entries. The plants leave that entry's excess
 * and the order is marked sow completed.
 */
export async function coverOrderFromEntries({
  order: orderInput,
  picks,
  userId,
  windowDays = 3,
  pastWindowDays = 12,
  additionalNeed = null,
}) {
  const orderOid = oid(orderInput?._id || orderInput);
  if (!orderOid) throw fail("ORDER_NOT_FOUND", "Order not found", 404);
  const order = await Order.findById(orderOid)
    .select(
      "orderId plantName plantSubtype deliveryDate numberOfPlants additionalPlants sowingPartialCover sowingDone sowingCoverSources"
    )
    .lean();
  if (!order) throw fail("ORDER_NOT_FOUND", "Order not found", 404);

  const list = normalizeEntryPicks(picks);
  const extra = additionalNeed != null ? int(additionalNeed) : 0;
  const alreadySowed = Boolean(order.sowingDone);
  if (alreadySowed && extra < 1) {
    throw fail("ALREADY_SOWED", "Order is already marked sow completed", 409);
  }
  const orderNeed = int(orderPlantsNeed(order));
  const need = alreadySowed ? extra : extra > 0 ? extra : Math.max(0, orderNeed - orderAlreadyCovered(order));
  if (need < 1) throw fail("NOTHING_TO_COVER", "This order has no plants left to cover");
  if (!picksMatchNeed(list, need)) {
    const sum = list.reduce((total, pick) => total + pick.plants, 0);
    throw fail("PICKS_MISMATCH", `Selected plants (${sum}) must equal ${need}`);
  }

  const cap = await excessWindowCapForPlant(order.plantName);
  const rows = await rowsForOrder({
    plantId: order.plantName,
    subtypeId: order.plantSubtype,
    deliveryDate: order.deliveryDate,
    releaseOrderId: orderOid,
    windowDays: Math.min(cap, Math.max(1, int(windowDays) || 3)),
    pastWindowDays: Math.min(cap, Math.max(0, int(pastWindowDays) || 12)),
  });
  let matched;
  try {
    matched = planEntryTakes(list, rows);
  } catch (err) {
    throw fail(err.code || "INSUFFICIENT_ENTRY_EXCESS", err.message, err.status || 409);
  }

  const applied = [];
  for (const pick of matched) {
    const saved = await takeFromEntry(pick.entryId, orderOid, pick.fromExcess);
    if (!saved) {
      for (const done of applied) await giveBack(done.entryId, orderOid, done.fromExcess);
      throw fail(
        "INSUFFICIENT_ENTRY_EXCESS",
        `${pick.requestNumber || "Sowing"} no longer has ${pick.fromExcess} free plants`,
        409
      );
    }
    applied.push(pick);
  }

  const now = new Date();
  const sources = matched.map((pick) => ({
    batchId: oid(pick.sourceBatchId),
    sowingRequestId: oid(pick.sowingRequestId),
    requestNumber: pick.requestNumber || "",
    plants: pick.plants,
    sowingDate: pick.sowingDate || "",
    plantReadyDate: pick.plantReadyDate || "",
    offsetDays: int(pick.offsetDays),
    reservedOnSource: true,
    moved: false,
  }));
  const prior = Array.isArray(order.sowingCoverSources) ? order.sowingCoverSources : [];
  const merged = [...prior, ...sources];
  const coveredAfter = orderCoveredFromSources({ sowingCoverSources: merged });
  const fullyCovered = coveredAfter >= orderNeed;
  if (!alreadySowed && !fullyCovered) {
    for (const done of applied) await giveBack(done.entryId, orderOid, done.fromExcess);
    throw fail("INSUFFICIENT_COVER", `Not enough cover to mark sown (have ${coveredAfter}, need ${orderNeed})`, 409);
  }

  const sourceReqId = oid(matched[0]?.sowingRequestId);
  const marked = await Order.findOneAndUpdate(
    alreadySowed ? { _id: orderOid, sowingDone: true } : { _id: orderOid, sowingDone: { $ne: true } },
    alreadySowed
      ? { $push: { sowingCoverSources: { $each: sources } } }
      : {
          $set: {
            sowingDone: true,
            sowingDoneAt: now,
            sowingCoverSources: merged,
            leftoverFromIncomplete: false,
            ...(sourceReqId ? { sowingDoneRequestId: sourceReqId } : {}),
          },
          $unset: { sowingCoverReversedAt: "", sowingPartialCover: "" },
        },
    { new: true }
  );
  if (!marked) {
    for (const done of applied) await giveBack(done.entryId, orderOid, done.fromExcess);
    throw fail("ALREADY_SOWED", "Order is already marked sow completed", 409);
  }

  const requestIds = [...new Set(matched.map((pick) => String(pick.sowingRequestId || "")).filter((id) => oid(id)))];
  if (requestIds.length) {
    await SowingRequest.updateMany(
      { _id: { $in: requestIds.map((id) => oid(id)) } },
      { $addToSet: { linkedOrderIds: orderOid } }
    );
  }

  return {
    orderId: order.orderId,
    need,
    sources,
    requestNumber: matched[0]?.requestNumber || "",
    remark: `Sow completed from excess: ${matched
      .map((pick) => `${pick.requestNumber || pick.sowingDate} ${pick.plants}`)
      .join(", ")}`,
    userId,
  };
}

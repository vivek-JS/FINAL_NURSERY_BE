/**
 * Single source of truth for sowing cover:
 *   order.sowingCoverSources
 *
 * Everything else is derived and must match:
 *   batch.orderCoveredPlants, excessAllocations, linkedOrderIds,
 *   shownExcess / buffer, order.sowingDone / leftoverFromIncomplete
 */

import mongoose from "mongoose";
import { sowCoverPool } from "./lagwadSlotPlantsSplit.js";
import { excessFieldsForBatch } from "./sowingBatchExcessStamp.js";
import {
  attributedCoverPlants,
  plantsFromOrderForRequest,
} from "./sowingBatchCoverAttribution.js";
import {
  canMarkOrderSowingDone,
  orderCoveredFromSources,
  orderPlantTotal,
} from "../services/orderSowCover.plan.js";
import { syncSowCompletedMetaFromBatch } from "./syncSowCompletedCoverMeta.js";

const intQty = (v) => Math.max(0, Math.floor(Number(v) || 0));

function oid(id) {
  if (!id) return null;
  if (id instanceof mongoose.Types.ObjectId) return id;
  const s = String(id?._id || id);
  return mongoose.Types.ObjectId.isValid(s) ? new mongoose.Types.ObjectId(s) : null;
}

/** Orders that claim this sowing via sources, allocs, links, or done-request. */
export async function loadOrdersForCoverTruth(db, { requestId, requestNumber, batch }) {
  const rid = oid(requestId);
  const linked = (batch?.linkedOrderIds || []).map(oid).filter(Boolean);
  const allocIds = (batch?.excessAllocations || [])
    .map((a) => oid(a?.orderId))
    .filter(Boolean);
  const or = [];
  if (rid) {
    or.push({ "sowingCoverSources.sowingRequestId": rid });
    or.push({ sowingDoneRequestId: rid });
    or.push({ "sowingPartialCover.requestId": rid });
  }
  if (requestNumber) or.push({ "sowingCoverSources.requestNumber": requestNumber });
  if (linked.length) or.push({ _id: { $in: linked } });
  if (allocIds.length) or.push({ _id: { $in: allocIds } });
  if (!or.length) return [];
  return db
    .collection("orders")
    .find({ $or: or })
    .project({
      orderId: 1,
      numberOfPlants: 1,
      additionalPlants: 1,
      sowingDone: 1,
      leftoverFromIncomplete: 1,
      sowingDoneRequestId: 1,
      sowingCoverSources: 1,
      sowingPartialCover: 1,
      orderStatus: 1,
    })
    .toArray();
}

/**
 * Derive batch cover + links from order.sowingCoverSources (strict, no invent).
 * Also returns per-order flag fixes (done only when sources fully cover).
 */
export function planCoverTruth({
  requestId,
  requestNumber,
  batch,
  orders = [],
  sowingBufferPct = 0,
} = {}) {
  const sowed = intQty(batch?.plantsSowed);
  const pct = batch?.noMortalityReserve
    ? 0
    : batch?.sowingBufferPct != null && Number.isFinite(Number(batch.sowingBufferPct))
      ? Number(batch.sowingBufferPct)
      : Number(sowingBufferPct) || 0;
  const saleable = batch?.noMortalityReserve ? sowed : sowCoverPool(sowed, pct);

  const allocMap = new Map();
  for (const a of batch?.excessAllocations || []) {
    const id = String(a?.orderId || "");
    if (!id) continue;
    allocMap.set(id, (allocMap.get(id) || 0) + intQty(a?.plants));
  }

  // Prefer sources; fall back to alloc/partial so we can promote them into sources.
  const attributed = attributedCoverPlants({
    requestId,
    requestNumber,
    batch,
    orders,
    inventDone: false,
  });

  const linkedOrderIds = [];
  const allocs = [];
  const orderFixes = [];
  const sourcePromotes = [];

  for (const order of orders || []) {
    const oidStr = String(order?._id || "");
    const fromHere = plantsFromOrderForRequest(order, {
      requestId,
      requestNumber,
      excessAlloc: allocMap.get(oidStr) || 0,
      inventDone: false,
    });
    if (fromHere > 0) {
      linkedOrderIds.push(order._id);
      allocs.push({
        orderId: order._id,
        orderCode: String(order.orderId ?? ""),
        plants: fromHere,
      });
      const fromSrc = plantsFromOrderForRequest(order, {
        requestId,
        requestNumber,
        excessAlloc: 0,
        inventDone: false,
      });
      // Promote alloc/partial into sowingCoverSources (single truth).
      if (fromSrc < 1) {
        sourcePromotes.push({
          orderId: order._id,
          plants: fromHere,
          sowingRequestId: oid(requestId),
          requestNumber: requestNumber || "",
        });
      }
    }

    const need = orderPlantTotal(order);
    const totalFromSources = orderCoveredFromSources(order);
    const willPromote = sourcePromotes.some((p) => String(p.orderId) === oidStr);
    const coveredForDone = totalFromSources > 0 ? totalFromSources : willPromote ? fromHere : 0;
    const shouldDone = need > 0 && coveredForDone >= need;
    const shouldPartial = !shouldDone && coveredForDone > 0;
    const curDone = Boolean(order.sowingDone);
    const curLeftover = Boolean(order.leftoverFromIncomplete);
    if (curDone !== shouldDone || curLeftover !== shouldPartial) {
      orderFixes.push({
        orderId: order._id,
        orderCode: order.orderId,
        fromHere,
        total: coveredForDone,
        need,
        sowingDone: shouldDone,
        leftoverFromIncomplete: shouldPartial,
        sowingDoneRequestId: shouldDone
          ? oid(
              (order.sowingCoverSources || []).find((s) => intQty(s?.plants) > 0)
                ?.sowingRequestId
            ) || oid(requestId)
          : null,
      });
    }
  }

  // Cover may use mortality only when sources already claim past saleable.
  const mortalityMovedToExcess = Math.max(0, attributed - saleable);
  const nextBatch = {
    ...batch,
    orderCoveredPlants: attributed,
    excessAllocations: allocs,
    linkedOrderIds,
    mortalityMovedToExcess,
    sowingBufferPct: pct,
  };
  const fields = excessFieldsForBatch(nextBatch, pct);

  return {
    attributed,
    stamped: intQty(batch?.orderCoveredPlants),
    drift: intQty(batch?.orderCoveredPlants) - attributed,
    linkedOrderIds,
    excessAllocations: allocs,
    sourcePromotes,
    mortalityMovedToExcess,
    sowingBufferPct: pct,
    bufferPlants: fields.bufferPlants,
    shownExcess: fields.shownExcess,
    orderFixes,
    changed:
      intQty(batch?.orderCoveredPlants) !== attributed ||
      intQty(batch?.mortalityMovedToExcess) !== mortalityMovedToExcess ||
      intQty(batch?.shownExcess ?? batch?.excessPlants) !== fields.shownExcess ||
      orderFixes.length > 0 ||
      sourcePromotes.length > 0,
  };
}

/**
 * Apply truth plan onto one plantslots batch path + order flags + sowing request links.
 */
export async function applyCoverTruth(db, {
  slotDocId,
  path, // { si, li, bi }
  requestId,
  requestNumber,
  plan,
  reason = "Reconcile cover from order.sowingCoverSources",
} = {}) {
  if (!plan || !slotDocId || !path) return { applied: false };
  const now = new Date();
  const base = `subtypeSlots.${path.si}.slots.${path.li}.sowingBatches.${path.bi}`;
  const linkedOids = (plan.linkedOrderIds || []).map(oid).filter(Boolean);

  await db.collection("plantslots").updateOne(
    { _id: oid(slotDocId) },
    {
      $set: {
        [`${base}.orderCoveredPlants`]: plan.attributed,
        [`${base}.orderReservedPlantsApplied`]: plan.attributed,
        [`${base}.excessAllocations`]: plan.excessAllocations,
        [`${base}.linkedOrderIds`]: linkedOids,
        [`${base}.mortalityMovedToExcess`]: plan.mortalityMovedToExcess,
        [`${base}.sowingBufferPct`]: plan.sowingBufferPct,
        [`${base}.bufferPlants`]: plan.bufferPlants,
        [`${base}.shownExcess`]: plan.shownExcess,
        [`${base}.excessPlants`]: plan.shownExcess,
      },
      $push: {
        [`${base}.changeLog`]: {
          at: now,
          by: null,
          kind: "COVER_TRUTH",
          plants: plan.drift,
          coverBefore: plan.stamped,
          coverAfter: plan.attributed,
          excessAfter: plan.shownExcess,
          orderId: null,
          orderCode: "",
          dispatchId: null,
          reason,
        },
      },
    }
  );

  const reqOid = oid(requestId);
  if (reqOid) {
    const req = await db.collection("sowingrequests").findOne(
      { _id: reqOid },
      { projection: { uncoveredOrderIds: 1 } }
    );
    const linkedSet = new Set(linkedOids.map(String));
    const stillUncovered = [];
    for (const id of req?.uncoveredOrderIds || []) {
      const idStr = String(id);
      if (linkedSet.has(idStr)) continue;
      const o = await db.collection("orders").findOne(
        { _id: oid(id) },
        { projection: { numberOfPlants: 1, additionalPlants: 1, sowingCoverSources: 1, sowingDone: 1 } }
      );
      if (!o || o.sowingDone) continue;
      if (orderCoveredFromSources(o) >= orderPlantTotal(o)) continue;
      stillUncovered.push(oid(id));
    }
    const incomplete =
      stillUncovered.length > 0 ||
      (plan.orderFixes || []).some((f) => f.leftoverFromIncomplete);
    await db.collection("sowingrequests").updateOne(
      { _id: reqOid },
      {
        $set: {
          linkedOrderIds: linkedOids,
          uncoveredOrderIds: stillUncovered,
          sowingIncomplete: incomplete,
        },
      }
    );
    // Keep SOW_COMPLETED meta cover/excess equal to the live batch stamp.
    await syncSowCompletedMetaFromBatch(db, {
      requestId: reqOid,
      batch: {
        sowingRequestId: reqOid,
        orderCoveredPlants: plan.attributed,
        shownExcess: plan.shownExcess,
        excessPlants: plan.shownExcess,
      },
      linkedOrderCount: linkedOids.length,
      reason: reason || "cover_truth",
    });
  }

  for (const promo of plan.sourcePromotes || []) {
    await db.collection("orders").updateOne(
      { _id: oid(promo.orderId) },
      {
        $push: {
          sowingCoverSources: {
            sowingRequestId: promo.sowingRequestId,
            requestNumber: promo.requestNumber,
            plants: promo.plants,
            at: now,
          },
          orderRemarks: `Cover truth: promote ${promo.plants} into sowingCoverSources (${promo.requestNumber})`,
        },
      }
    );
  }

  for (const fix of plan.orderFixes || []) {
    const set = {
      sowingDone: fix.sowingDone,
      leftoverFromIncomplete: fix.leftoverFromIncomplete,
    };
    const unset = {};
    if (fix.sowingDone) {
      set.sowingDoneAt = now;
      if (fix.sowingDoneRequestId) set.sowingDoneRequestId = fix.sowingDoneRequestId;
      unset.sowingPartialCover = "";
    } else {
      unset.sowingDoneRequestId = "";
      unset.sowingDoneAt = "";
    }
    await db.collection("orders").updateOne(
      { _id: oid(fix.orderId) },
      {
        $set: set,
        ...(Object.keys(unset).length ? { $unset: unset } : {}),
        $push: {
          orderRemarks: `Cover truth: sources ${fix.total}/${fix.need} → sowingDone=${fix.sowingDone}`,
        },
      }
    );
  }

  return {
    applied: true,
    attributed: plan.attributed,
    orderFixes: plan.orderFixes.length,
    sourcePromotes: (plan.sourcePromotes || []).length,
  };
}

export async function reconcileBatchCoverTruth(db, {
  slotDocId,
  path,
  batch,
  requestId,
  requestNumber,
  sowingBufferPct = 0,
  apply = false,
  reason,
} = {}) {
  const orders = await loadOrdersForCoverTruth(db, { requestId, requestNumber, batch });
  const plan = planCoverTruth({
    requestId,
    requestNumber,
    batch,
    orders,
    sowingBufferPct,
  });
  if (!apply || !plan.changed) return { plan, orders, applied: false };
  const result = await applyCoverTruth(db, {
    slotDocId,
    path,
    requestId,
    requestNumber,
    plan,
    reason,
  });
  return { plan, orders, ...result };
}

/** Convenience: canMark done only from sources (re-export). */
export { canMarkOrderSowingDone };

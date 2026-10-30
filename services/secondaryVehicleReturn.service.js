import mongoose from "mongoose";
import moment from "moment";
import PlantOutward from "../models/plantOutward.model.js";
import DispatchBatch from "../models/dispatchBatch.model.js";
import Dispatch from "../models/dispatch.model.js";
import AppError from "../utility/appError.js";
import { collectLoadedOutwardLinesForDispatch } from "./secondaryVehicleUnload.service.js";
import { restoreSowBatchDispatch } from "./sowDispatchBatches.service.js";
import { syncSecondaryInwardSlotStockAdd } from "./secondaryShedSlotStock.service.js";
import { recordSecondaryInwardOnLedger } from "./secondaryDispatchAvailability.service.js";
import { SHED_ACTIVITY_ACTIONS, recordShedActivity } from "./shedActivity.service.js";

const toInt = (v) => Math.max(0, Math.floor(Number(v) || 0));
const idStr = (v) => (v == null || v === "" ? "" : String(v));

export const VEHICLE_RETURN_SOURCES = ["APP", "COMPLETE_FORM"];

/** Plants already put back to a shed from this vehicle, optionally for one order. */
export function sumShedReturns(shedReturns, { orderId, batchId, sourceOutwardId } = {}) {
  let n = 0;
  for (const r of shedReturns || []) {
    if (orderId && idStr(r.orderId) !== idStr(orderId)) continue;
    if (batchId && idStr(r.batchId) !== idStr(batchId)) continue;
    if (sourceOutwardId && idStr(r.sourceOutwardId) !== idStr(sourceOutwardId)) continue;
    n += toInt(r.quantity);
  }
  return n;
}

/**
 * Pure cap check for a vehicle return. `lines` are loaded outward lines of the vehicle
 * (collectLoadedOutwardLinesForDispatch). Returns { error } or the resolved source line + order.
 * Cap is enforced per batch (and order when known) and per source outward line when given.
 */
export function planVehicleReturn({ lines, priorReturns, batchId, sourceOutwardId, orderId, quantity }) {
  const qty = toInt(quantity);
  if (qty < 1) return { error: "Return quantity must be at least 1" };

  const batchLines = (lines || []).filter((l) => idStr(l.batchId) === idStr(batchId));
  if (!batchLines.length) return { error: "This batch was not loaded on this vehicle" };

  let sourceLine = null;
  if (sourceOutwardId) {
    sourceLine = batchLines.find((l) => idStr(l.secondaryOutwardId) === idStr(sourceOutwardId));
    if (!sourceLine) return { error: "Loaded line not found on this vehicle" };
  }

  let resolvedOrderId = idStr(orderId) || idStr(sourceLine?.linkedOrderId);
  if (!resolvedOrderId) {
    const orders = new Set(batchLines.map((l) => idStr(l.linkedOrderId)).filter(Boolean));
    if (orders.size === 1) resolvedOrderId = [...orders][0];
  }

  const scoped = resolvedOrderId
    ? batchLines.filter((l) => !l.linkedOrderId || idStr(l.linkedOrderId) === resolvedOrderId)
    : batchLines;
  const loaded = scoped.reduce((s, l) => s + toInt(l.plants), 0);
  const alreadyReturned = sumShedReturns(priorReturns, {
    batchId,
    orderId: resolvedOrderId || undefined,
  });
  let maxReturnable = Math.max(0, loaded - alreadyReturned);

  if (sourceLine) {
    const lineLeft =
      toInt(sourceLine.plants) - sumShedReturns(priorReturns, { sourceOutwardId });
    maxReturnable = Math.min(maxReturnable, Math.max(0, lineLeft));
  }

  if (qty > maxReturnable) {
    return { error: `Only ${maxReturnable} plants of this batch can be returned from this vehicle` };
  }

  return {
    quantity: qty,
    orderId: resolvedOrderId || null,
    sourceLine: sourceLine || scoped[0] || batchLines[0],
    loaded,
    alreadyReturned,
    maxReturnable,
  };
}

/**
 * Put plants from a vehicle back into a shed as a new secondary inward line (isReturn=true).
 * Stock only: slot + ledger get the plants back; order money, shed-loaded totals and vehicle
 * status are not touched. Joins `session` when given (complete form), else runs its own transaction.
 */
export async function returnPlantsFromVehicle({
  dispatchId,
  batchId,
  sourceOutwardId,
  orderId,
  pollyhouse,
  quantity,
  reason,
  source = "APP",
  performedBy,
  session: outerSession,
}) {
  if (!mongoose.isValidObjectId(String(dispatchId)) || !mongoose.isValidObjectId(String(batchId))) {
    throw new AppError("Invalid vehicle or batch id", 400);
  }
  const shed = String(pollyhouse ?? "").trim();
  const src = VEHICLE_RETURN_SOURCES.includes(source) ? source : "APP";
  const by = performedBy && mongoose.isValidObjectId(String(performedBy)) ? performedBy : null;
  const reasonStr = String(reason ?? "").trim().slice(0, 500);

  const { lines } = await collectLoadedOutwardLinesForDispatch(dispatchId);

  const run = async (session) => {
    const dispatch = await Dispatch.findById(dispatchId)
      .select("transportStatus isDeleted shedReturns shedReturnedPlants")
      .session(session);
    if (!dispatch || dispatch.isDeleted) throw new AppError("Vehicle not found", 404);
    if (src === "APP" && dispatch.transportStatus !== "LOADED") {
      throw new AppError("Returns from the app are only allowed on loaded vehicles", 400);
    }

    const plan = planVehicleReturn({
      lines,
      priorReturns: dispatch.shedReturns,
      batchId,
      sourceOutwardId,
      orderId,
      quantity,
    });
    if (plan.error) throw new AppError(plan.error, 400);

    const po = await PlantOutward.findOne({ batchId }).session(session);
    if (!po) throw new AppError("No plant outward found for this batch", 404);
    const batchLean = await DispatchBatch.findById(batchId)
      .select("batchNumber dateAdded primaryPlantReadyDays secondaryPlantReadyDays secondaryR2PlantReadyDays secondaryR3PlantReadyDays")
      .session(session)
      .lean();

    const ln = plan.sourceLine;
    const outward = ln.secondaryOutwardId ? po.secondaryOutward.id(ln.secondaryOutwardId) : null;
    const now = new Date();

    if (outward?.sowBucket) {
      const restoreResult = await restoreSowBatchDispatch({
        session,
        outward,
        plants: plan.quantity,
        dispatchId,
        performedBy: by,
      });
      if (!restoreResult?.restored) {
        throw new AppError("Could not restore sowing-batch stock for this return", 400);
      }
      outward.sowAvailableDec = Math.max(0, toInt(outward.sowAvailableDec) - (restoreResult.fromAvail || 0));
      outward.sowReservedDec = Math.max(0, toInt(outward.sowReservedDec) - (restoreResult.fromReserved || 0));
      await po.save({ session, validateModifiedOnly: true });

      const entry = {
        orderId: plan.orderId,
        batchId,
        batchNumber: batchLean?.batchNumber != null ? String(batchLean.batchNumber) : ln.batchNumber || "",
        sourceOutwardId: ln.secondaryOutwardId || null,
        secondaryInwardId: null,
        pollyhouse: shed || outward.pollyhouse || "",
        quantity: plan.quantity,
        reason: reasonStr,
        source: src,
        returnedAt: now,
        returnedBy: by,
        sowBucket: outward.sowBucket,
      };
      await Dispatch.updateOne(
        { _id: dispatchId },
        { $push: { shedReturns: entry }, $inc: { shedReturnedPlants: plan.quantity } },
        { session }
      );
      return {
        dispatchId: String(dispatchId),
        batchId: String(batchId),
        batchNumber: entry.batchNumber,
        orderId: plan.orderId,
        secondaryInwardId: null,
        pollyhouse: entry.pollyhouse,
        quantity: plan.quantity,
        returnedDate: moment(now).format("YYYY-MM-DD"),
        sowBucket: outward.sowBucket,
        slotRestore: restoreResult.restored,
      };
    }

    if (!shed) throw new AppError("Choose the shed to return plants into", 400);
    const srcInward = ln.secondaryInwardId ? po.secondaryInward.id(ln.secondaryInwardId) : null;
    const cavity = Math.max(1, toInt(ln.cavity || srcInward?.cavity) || 1);
    const trays = Math.max(1, Math.ceil(plan.quantity / cavity));
    const inwardDate = srcInward?.secondaryInwardDate || ln.secondaryInwardDate || ln.loadedAt || now;
    const readyDate = srcInward?.expectedReadyDate || ln.sowReadyPlantReadyDate || null;

    po.secondaryInward.push({
      secondaryInwardDate: inwardDate,
      numberOfBottles: trays,
      size: srcInward?.size || ln.size || "R2",
      cavity,
      numberOfTrays: trays,
      totalQuantity: plan.quantity,
      availableQuantity: plan.quantity,
      pollyhouse: shed,
      laboursEngaged: 1,
      transferStatus: "available",
      dateOfDispatch: srcInward?.dateOfDispatch || readyDate || now,
      ...(readyDate ? { expectedReadyDate: readyDate } : {}),
      ...(srcInward?.linkedBookingSlotId ? { linkedBookingSlotId: srcInward.linkedBookingSlotId } : {}),
      // Plants already went out on a vehicle, so they are ready to sell again.
      readinessBypassAt: now,
      readinessBypassBy: by,
      readinessBypassReason: "Returned from vehicle",
      isReturn: true,
      returnedFromDispatchId: dispatchId,
      returnedFromOutwardId: ln.secondaryOutwardId || null,
      returnedFromOrderId: plan.orderId,
      returnReason: reasonStr,
      returnedAt: now,
      returnedBy: by,
    });
    const line = po.secondaryInward[po.secondaryInward.length - 1];
    await po.save({ session, validateModifiedOnly: true });

    await recordSecondaryInwardOnLedger(session, {
      dispatchBatchId: batchId,
      plantOutwardId: po._id,
      secondaryInwardId: line._id,
      secondaryInwardDate: inwardDate,
      plants: plan.quantity,
      size: line.size,
      performedBy: by || undefined,
    });

    await recordShedActivity({
      batchId,
      subdocId: line._id,
      action: SHED_ACTIVITY_ACTIONS.SECONDARY_RETURN,
      activityName: `Returned from vehicle · ${plan.quantity} plants`,
      performedBy: by,
      quantity: plan.quantity,
      newValue: { pollyhouse: shed, dispatchId: String(dispatchId), orderId: plan.orderId },
      reason: reasonStr,
      metadata: { source: src, sourceOutwardId: ln.secondaryOutwardId || null },
      session,
    });

    let slot = null;
    try {
      slot = await syncSecondaryInwardSlotStockAdd({
        session,
        batchId,
        secondaryInwardId: line._id,
        batchLean,
        siPlain: line.toObject(),
        dispatchEligible: true,
        force: true,
        performedBy: by || undefined,
      });
    } catch (slotErr) {
      console.warn("[secondaryVehicleReturn] slot sync:", slotErr?.message || slotErr);
    }

    const entry = {
      orderId: plan.orderId,
      batchId,
      batchNumber: batchLean?.batchNumber != null ? String(batchLean.batchNumber) : ln.batchNumber || "",
      sourceOutwardId: ln.secondaryOutwardId || null,
      secondaryInwardId: line._id,
      pollyhouse: shed,
      quantity: plan.quantity,
      reason: reasonStr,
      source: src,
      returnedAt: now,
      returnedBy: by,
    };
    await Dispatch.updateOne(
      { _id: dispatchId },
      { $push: { shedReturns: entry }, $inc: { shedReturnedPlants: plan.quantity } },
      { session }
    );

    return {
      dispatchId: String(dispatchId),
      batchId: String(batchId),
      batchNumber: entry.batchNumber,
      orderId: plan.orderId,
      secondaryInwardId: String(line._id),
      pollyhouse: shed,
      quantity: plan.quantity,
      returnedDate: moment(now).format("YYYY-MM-DD"),
      slot,
    };
  };

  if (outerSession) return run(outerSession);

  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      result = await run(session);
    });
    return result;
  } finally {
    await session.endSession();
  }
}

/**
 * Delivery complete form: `orderUpdates[i].returnToShed = [{ batchId, sourceOutwardId, pollyhouse, quantity }]`.
 * Restocks inside the complete transaction. Shed returns for an order (app + this form) may not
 * exceed the plants returned on that order.
 */
export async function applyCompleteFormShedReturns({
  session,
  dispatch,
  orderUpdates,
  updatedOrders,
  performedBy,
}) {
  const returnedByOrder = new Map(
    (updatedOrders || [])
      .filter(Boolean)
      .map((o) => [String(o._id), toInt(o.returnedPlants)])
  );
  const results = [];
  for (const u of orderUpdates || []) {
    const rows = (Array.isArray(u?.returnToShed) ? u.returnToShed : []).filter(
      (r) => toInt(r?.quantity) > 0
    );
    if (!rows.length || !u.orderId) continue;
    const orderId = String(u.orderId);
    const wanted = rows.reduce((s, r) => s + toInt(r.quantity), 0);
    const already = sumShedReturns(dispatch.shedReturns, { orderId });
    const allowed = returnedByOrder.get(orderId) ?? toInt(u.returnedPlants);
    if (wanted + already > allowed) {
      throw new AppError(
        `Return to shed (${wanted}) plus earlier shed returns (${already}) is more than the ${allowed} plants returned on this order`,
        400
      );
    }
    for (const r of rows) {
      results.push(
        await returnPlantsFromVehicle({
          dispatchId: dispatch._id,
          batchId: r.batchId,
          sourceOutwardId: r.sourceOutwardId,
          orderId,
          pollyhouse: r.pollyhouse,
          quantity: r.quantity,
          reason: u.returnReason || "Returned on delivery complete",
          source: "COMPLETE_FORM",
          performedBy,
          session,
        })
      );
    }
  }
  return results;
}

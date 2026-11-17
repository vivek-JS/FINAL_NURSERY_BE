import mongoose from "mongoose";
import PlantOutward from "../models/plantOutward.model.js";
import DispatchBatch from "../models/dispatchBatch.model.js";
import AppError from "../utility/appError.js";
import { splitLagwadQtyForSlot } from "../utility/lagwadSlotPlantsSplit.js";
import { applySecondaryInwardDestroyToSlot } from "./secondaryShedSlotStock.service.js";
import { recordSecondaryDestroyOnLedger } from "./secondaryDispatchAvailability.service.js";
import { SHED_ACTIVITY_ACTIONS } from "./shedActivity.service.js";

const toInt = (v) => Math.max(0, Math.floor(Number(v) || 0));

/**
 * Pure destroy math for one lagwad line. Loss is charged to the line's 10% expected
 * mortality allowance first; only the rest reduces the slot-synced sellable position.
 */
export function planSecondaryDestroy(line, quantity) {
  const total = toInt(line?.totalQuantity);
  const avail = toInt(line?.availableQuantity);
  const destroyedBefore = toInt(line?.destroyedQuantity);
  const synced = toInt(line?.slotStockSyncedPlants);
  const qty = toInt(quantity);

  if (qty < 1) return { error: "Destroyed quantity must be at least 1" };
  if (qty > avail) return { error: `Only ${avail} plants are left on this entry` };

  const allowance = Math.max(0, splitLagwadQtyForSlot(total).expectedMortality - destroyedBefore);
  const fromMortality = Math.min(qty, allowance);
  const fromSellable = qty - fromMortality;
  const availAfter = avail - qty;
  const syncedAfter = Math.min(Math.max(0, synced - fromSellable), availAfter);

  return {
    quantity: qty,
    fromMortality,
    fromSellable,
    availAfter,
    destroyedAfter: destroyedBefore + qty,
    syncedAfter,
    sellableSlotDec: synced - syncedAfter,
  };
}

/**
 * Final numbers for a set of lagwad lines. Return lines (plants that came back from a vehicle)
 * are not planting: they are counted as `returned`, and net sold = planted - in shed - destroyed.
 */
export function summarizeLagwadLines(lines) {
  let gross = 0;
  let returned = 0;
  let inShed = 0;
  let destroyed = 0;
  for (const l of lines || []) {
    if (l.isReturn) returned += toInt(l.totalQuantity);
    else gross += toInt(l.totalQuantity);
    inShed += toInt(l.availableQuantity);
    destroyed += toInt(l.destroyedQuantity);
  }
  const sold = Math.max(0, gross - inShed - destroyed);
  const mortalityPct = gross > 0 ? Math.round((destroyed / gross) * 1000) / 10 : 0;
  return { gross, sold, destroyed, returned, inShed, mortalityPct, lines: (lines || []).length };
}

function sameShed(a, b) {
  return String(a ?? "").trim() === String(b ?? "").trim();
}

const BATCH_READY_SELECT = "batchNumber secondaryPlantReadyDays secondaryR2PlantReadyDays secondaryR3PlantReadyDays";

/** Destroy `quantity` on one line inside an open transaction; caller saves `po`. */
async function applyDestroyToLine({ session, po, si, batchId, batchLean, quantity, reasonStr, by }) {
  const plan = planSecondaryDestroy(si, quantity);
  if (plan.error) throw new AppError(plan.error, 400);

  const slot = await applySecondaryInwardDestroyToSlot({
    session,
    batchId,
    batchLean,
    siPlain: si.toObject(),
    fromMortality: plan.fromMortality,
    sellableSlotDec: plan.sellableSlotDec,
    performedBy: by,
  });

  const prevAvail = toInt(si.availableQuantity);
  si.availableQuantity = plan.availAfter;
  si.destroyedQuantity = plan.destroyedAfter;
  si.slotStockSyncedPlants = plan.syncedAfter;
  if (plan.availAfter === 0) si.transferStatus = "fully_transferred";
  si.destroyLog.push({
    quantity: plan.quantity,
    reason: reasonStr,
    recordedBy: by,
    fromMortality: plan.fromMortality,
    fromSellable: plan.fromSellable,
  });
  si.activityLog.push({
    action: SHED_ACTIVITY_ACTIONS.SECONDARY_DESTROYED,
    activityName: "Plants destroyed",
    performedBy: by,
    quantity: plan.quantity,
    previousValue: { availableQuantity: prevAvail },
    newValue: { availableQuantity: plan.availAfter, destroyedQuantity: plan.destroyedAfter },
    reason: reasonStr,
    metadata: { fromMortality: plan.fromMortality, fromSellable: plan.fromSellable, slot },
  });

  return { plan, slot };
}

export async function destroySecondaryInwardPlants({
  batchId,
  secondaryInwardId,
  quantity,
  reason,
  performedBy,
}) {
  if (!mongoose.isValidObjectId(String(batchId)) || !mongoose.isValidObjectId(String(secondaryInwardId))) {
    throw new AppError("Invalid batch or lagwad entry id", 400);
  }
  const by = performedBy && mongoose.isValidObjectId(String(performedBy)) ? performedBy : undefined;
  const reasonStr = String(reason ?? "").trim().slice(0, 500);

  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      const po = await PlantOutward.findOne({ batchId }).session(session);
      if (!po) throw new AppError("No plant outward found for this batch", 404);
      const si = po.secondaryInward.id(secondaryInwardId);
      if (!si) throw new AppError("Lagwad entry not found", 404);

      const batchLean = await DispatchBatch.findById(batchId)
        .select(BATCH_READY_SELECT)
        .session(session)
        .lean();

      const { plan, slot } = await applyDestroyToLine({
        session, po, si, batchId, batchLean, quantity, reasonStr, by,
      });
      await po.save({ session, validateBeforeSave: true });

      await recordSecondaryDestroyOnLedger(session, {
        dispatchBatchId: batchId,
        plantOutwardId: po._id,
        secondaryInwardId,
        quantity: plan.quantity,
        performedBy: by,
        reason: reasonStr,
      });

      result = {
        secondaryInwardId: String(secondaryInwardId),
        destroyed: plan.quantity,
        fromMortality: plan.fromMortality,
        fromSellable: plan.fromSellable,
        availableQuantity: plan.availAfter,
        destroyedQuantity: plan.destroyedAfter,
        slot,
      };
    });
    return result;
  } finally {
    await session.endSession();
  }
}

/**
 * Destroy every remaining plant of a batch (optionally only in one shed) and close those lines.
 * Returns { destroyedNow, summary } where summary covers all lines in scope.
 */
export async function destroyAllRemaining({ batchId, pollyhouse, reason, performedBy }) {
  if (!mongoose.isValidObjectId(String(batchId))) {
    throw new AppError("Invalid batch id", 400);
  }
  const by = performedBy && mongoose.isValidObjectId(String(performedBy)) ? performedBy : undefined;
  const reasonStr = String(reason ?? "").trim().slice(0, 500) || "Destroy all remaining";
  const shed = String(pollyhouse ?? "").trim();

  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      const po = await PlantOutward.findOne({ batchId }).session(session);
      if (!po) throw new AppError("No plant outward found for this batch", 404);

      const inScope = (po.secondaryInward || []).filter((si) => !shed || sameShed(si.pollyhouse, shed));
      if (!inScope.length) throw new AppError("No lagwad entries in this scope", 404);
      const targets = inScope.filter((si) => toInt(si.availableQuantity) > 0);
      if (!targets.length) throw new AppError("Nothing left to destroy", 400);

      const batchLean = await DispatchBatch.findById(batchId)
        .select(BATCH_READY_SELECT)
        .session(session)
        .lean();

      const destroyedLines = [];
      for (const si of targets) {
        const { plan } = await applyDestroyToLine({
          session, po, si, batchId, batchLean,
          quantity: toInt(si.availableQuantity), reasonStr, by,
        });
        destroyedLines.push({ secondaryInwardId: si._id, quantity: plan.quantity });
      }
      await po.save({ session, validateBeforeSave: true });

      for (const d of destroyedLines) {
        await recordSecondaryDestroyOnLedger(session, {
          dispatchBatchId: batchId,
          plantOutwardId: po._id,
          secondaryInwardId: d.secondaryInwardId,
          quantity: d.quantity,
          performedBy: by,
          reason: reasonStr,
        });
      }

      result = {
        batchId: String(batchId),
        batchNumber: batchLean?.batchNumber ?? "",
        pollyhouse: shed || null,
        destroyedNow: destroyedLines.reduce((s, d) => s + d.quantity, 0),
        linesClosed: destroyedLines.length,
        summary: summarizeLagwadLines(inScope),
      };
    });
    return result;
  } finally {
    await session.endSession();
  }
}

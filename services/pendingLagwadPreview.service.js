/**
 * Batch-line preview for pending lagwad roll (calendar-ready secondary inward on expired slots).
 */

import mongoose from "mongoose";
import moment from "moment";
import PlantOutward from "../models/plantOutward.model.js";
import { secondaryInwardCalendarReady } from "./secondaryShedSlotStock.service.js";

const BATCH_SELECT = "batchNumber plantCmsId plantSubtypeId secondaryPlantReadyDays";

/**
 * Attach batch rows to pendingLagwadBySlot buckets (mutates pastDueDetail in place).
 */
export async function enrichPendingLagwadBatchPreviews(pastDueDetail, asOfDate = new Date()) {
  const buckets = pastDueDetail?.pendingLagwadBySlot;
  if (!Array.isArray(buckets) || !buckets.length) return pastDueDetail;

  const slotIdSet = new Set(buckets.map((b) => String(b.slotId)));
  const slotOids = [...slotIdSet]
    .filter((id) => mongoose.isValidObjectId(id))
    .map((id) => new mongoose.Types.ObjectId(id));

  if (!slotOids.length) return pastDueDetail;

  const today = moment(asOfDate).startOf("day");
  const bySlot = new Map();
  for (const id of slotIdSet) {
    bySlot.set(id, []);
  }

  const pos = await PlantOutward.find({
    "secondaryInward.linkedBookingSlotId": { $in: slotOids },
  })
    .populate({ path: "batchId", select: BATCH_SELECT })
    .lean();

  for (const po of pos) {
    const batchLean = po.batchId && typeof po.batchId === "object" ? po.batchId : null;
    for (const si of po.secondaryInward || []) {
      const linked = si.linkedBookingSlotId?.toString?.() ?? String(si.linkedBookingSlotId || "");
      if (!slotIdSet.has(linked)) continue;
      if (!secondaryInwardCalendarReady(si, batchLean, today)) continue;
      const plants = Math.max(
        0,
        Number(si.slotStockSyncedPlants ?? si.onSlotPlants ?? si.availableQuantity) || 0
      );
      if (plants < 1) continue;
      bySlot.get(linked).push({
        batchNumber: batchLean?.batchNumber ?? "",
        pollyhouse: si.pollyhouse ?? "",
        plants,
        expectedReadyDate: si.expectedReadyDate ?? null,
        secondaryInwardId: si._id?.toString?.() ?? String(si._id),
      });
    }
  }

  for (const bucket of buckets) {
    bucket.batches = bySlot.get(String(bucket.slotId)) || [];
  }

  return pastDueDetail;
}

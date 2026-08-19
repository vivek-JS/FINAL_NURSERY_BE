/**
 * Daily cron: relocate calendar-ready secondary inward lines to current ongoing slot.
 */

import mongoose from "mongoose";
import moment from "moment";
import PlantOutward from "../models/plantOutward.model.js";
import {
  relocateSecondaryInwardSlotOnCalendarReady,
  secondaryInwardCalendarReady,
} from "./secondaryShedSlotStock.service.js";

const BATCH_SELECT =
  "batchNumber dateAdded primaryPlantReadyDays secondaryPlantReadyDays plantCmsId plantSubtypeId";

/**
 * Scan all secondary inward lines; relocate calendar-ready lines off non-current slots.
 */
export async function runCalendarReadySlotRelocate({ asOfDate = new Date() } = {}) {
  const today = moment(asOfDate).startOf("day");
  let relocated = 0;
  let skipped = 0;
  let errors = 0;

  const pos = await PlantOutward.find({
    "secondaryInward.0": { $exists: true },
  })
    .populate({ path: "batchId", select: BATCH_SELECT })
    .lean();

  for (const po of pos) {
    const batchLean = po.batchId && typeof po.batchId === "object" ? po.batchId : null;
    const batchId = batchLean?._id ?? po.batchId;
    if (!batchId || !batchLean) continue;

    for (const si of po.secondaryInward || []) {
      const avail = Math.max(0, Number(si.availableQuantity) || 0);
      const synced = Math.max(0, Number(si.slotStockSyncedPlants) || 0);
      if (avail < 1 && synced < 1) continue;

      if (!secondaryInwardCalendarReady(si, batchLean, today)) {
        skipped += 1;
        continue;
      }

      try {
        const result = await relocateSecondaryInwardSlotOnCalendarReady({
          batchId,
          secondaryInwardId: String(si._id),
          batchLean,
          siPlain: si,
          performedBy: null,
        });
        if (result?.relocated || (result?.applied > 0 && result?.newSlotId)) {
          relocated += 1;
        } else {
          skipped += 1;
        }
      } catch (err) {
        errors += 1;
        console.warn(
          "[CalendarReadyRelocate] line",
          si._id,
          err?.message || err
        );
      }
    }
  }

  return { relocated, skipped, errors, asOf: today.format("YYYY-MM-DD") };
}

export function computeOverdueDays(expectedReadyDate, asOfDate = new Date()) {
  if (!expectedReadyDate || !moment(expectedReadyDate).isValid()) return 0;
  const today = moment(asOfDate).startOf("day");
  const expected = moment(expectedReadyDate).startOf("day");
  if (today.isBefore(expected, "day")) return 0;
  return today.diff(expected, "days");
}

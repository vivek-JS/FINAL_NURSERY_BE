import { deliveryDateToIstMoment, slotDayStartMoment } from "../../utility/istSlotDate.js";
import { excessReadyInWindow } from "../../utility/excessCoverWindow.js";

const intQty = (v) => Math.max(0, Math.floor(Number(v) || 0));

function readyOffset(plantReadyDate, deliveryIst) {
  const ready = slotDayStartMoment(plantReadyDate) || deliveryDateToIstMoment(plantReadyDate);
  if (!ready || !deliveryIst) return null;
  return ready.diff(deliveryIst, "days");
}

/** Plants this order's cover rows give back to one sowing entry. */
export function releasedPlantsForEntry(entry, sources = []) {
  const batchId = String(entry?.sourceBatchId || "");
  const requestId = String(entry?.sowingRequestId || "");
  const requestNumber = String(entry?.requestNumber || "");
  let fromBatch = 0;
  let fromRequest = 0;
  for (const src of sources) {
    const plants = intQty(src?.plants);
    if (plants < 1) continue;
    const srcBatch = String(src?.batchId || "");
    if (batchId && srcBatch && srcBatch === batchId) {
      fromBatch += plants;
      continue;
    }
    if (srcBatch) continue;
    const same =
      (requestId && String(src?.sowingRequestId || "") === requestId) ||
      (requestNumber && String(src?.requestNumber || "") === requestNumber);
    if (same) fromRequest += plants;
  }
  return fromBatch || fromRequest;
}

/**
 * Bookable excess from sowingentries whose ready day sits in the delivery window.
 * `releasedById` adds back plants still covered by the order being moved.
 */
export function collectionExcessRows(docs, { deliveryDate, windowDays, pastWindowDays, releasedById }) {
  const deliveryIst = deliveryDateToIstMoment(deliveryDate);
  const win = Math.max(0, Math.floor(Number(windowDays) || 0));
  const past = Math.max(0, Math.floor(Number(pastWindowDays) || 0));
  const released = releasedById || new Map();
  const entries = [];
  for (const doc of docs || []) {
    if (doc?.isIrrelevant) continue;
    const offsetDays = readyOffset(doc.plantReadyDate, deliveryIst);
    if (offsetDays == null || !excessReadyInWindow(offsetDays, win, past)) continue;
    const extra = intQty(released.get(String(doc._id)));
    const freePlants = intQty(doc.excessPlants) + extra;
    if (freePlants < 1) continue;
    entries.push({
      entryId: String(doc._id),
      sourceBatchId: doc.sourceBatchId ? String(doc.sourceBatchId) : "",
      requestNumber: doc.requestNumber || "",
      plantName: doc.plantName || "",
      subtypeName: doc.subtypeName || "",
      sowingDate: doc.sowDay || doc.sowingDate || "",
      plantReadyDate: doc.plantReadyDate || "",
      offsetDays,
      sowedQuantity: intQty(doc.plantsSowed),
      bookedPlants: intQty(doc.orderCoveredPlants),
      excessPlants: intQty(doc.excessPlants),
      freePlants,
    });
  }
  entries.sort(
    (a, b) => Math.abs(a.offsetDays) - Math.abs(b.offsetDays) || a.offsetDays - b.offsetDays
  );
  const totalFree = entries.reduce((sum, row) => sum + row.freePlants, 0);
  return { totalFree, entries };
}

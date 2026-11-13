import { excessFieldsForBatch } from "../../utility/sowingBatchExcessStamp.js";

/** DD-MM-YYYY or ISO prefix → YYYY-MM-DD. Empty when the value is not a day. */
export function sowDayFrom(value) {
  const text = String(value || "").trim();
  const dmy = text.match(/^(\d{2})-(\d{2})-(\d{4})$/);
  if (dmy) return `${dmy[3]}-${dmy[2]}-${dmy[1]}`;
  const ymd = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (ymd) return `${ymd[1]}-${ymd[2]}-${ymd[3]}`;
  return "";
}

/**
 * Cover on the new sowing list is the order quantity taken here.
 * A full order counts its whole quantity. A partial counts only the plants
 * taken, not the rest of the order and not the sow quantity.
 * When the order split is unknown, a stamp of the whole sow is capped at
 * expected ready so the sow is not shown as cover.
 */
export function coverShownForEntry(doc, orderPlants = null) {
  const fromOrders = Number(orderPlants);
  if (Number.isFinite(fromOrders) && fromOrders > 0) return Math.floor(fromOrders);
  const preview = excessFieldsForBatch(doc, doc?.sowingBufferPct || 0);
  const sowed = Math.max(0, Math.floor(Number(doc?.plantsSowed) || 0));
  const moved = Math.max(0, Math.floor(Number(doc?.mortalityMovedToExcess) || 0));
  const mortality = doc?.noMortalityReserve ? 0 : Math.max(0, preview.bufferPlants - moved);
  const saleable = Math.max(0, sowed - mortality);
  const stored = Math.max(0, Math.floor(Number(doc?.orderCoveredPlants) || 0));
  return Math.min(stored, saleable);
}

/**
 * Same numbers the sowing-entries grid reads: sowed, cover, excess, mortality.
 * Excess is sowed − CMS mortality − cover. A stored excessPlants stamp is not shown.
 */
export function toSowingEntryListItem(doc, orderPlants = null) {
  const cover = coverShownForEntry(doc, orderPlants);
  const fields = excessFieldsForBatch(
    { ...doc, orderCoveredPlants: cover },
    doc?.sowingBufferPct || 0
  );
  const sowed = Math.max(0, Math.floor(Number(doc?.plantsSowed) || 0));
  const excess = fields.shownExcess;
  const buffer = fields.bufferPlants;
  const moved = Math.max(0, Math.floor(Number(doc?.mortalityMovedToExcess) || 0));
  const mortality = doc?.noMortalityReserve ? 0 : Math.max(0, buffer - moved);
  const ready = doc?.plantReadyDate || "";
  const fromOrders = Number(orderPlants);
  const orderTotal = Number.isFinite(fromOrders) && fromOrders > 0 ? Math.floor(fromOrders) : null;
  return {
    _id: String(doc?._id || ""),
    sowingRequestId: doc?.sowingRequestId ? String(doc.sowingRequestId) : "",
    requestNumber: doc?.requestNumber || "",
    plantId: doc?.plantId || null,
    plantName: doc?.plantName || "",
    subtypeId: doc?.subtypeId || null,
    subtypeName: doc?.subtypeName || "",
    year: doc?.year ?? null,
    sowingDate: doc?.sowDay || sowDayFrom(doc?.sowingDate),
    plantReadyDate: ready,
    out: doc?.out || "",
    dispatchedPlants: Math.max(0, Math.floor(Number(doc?.dispatchedPlants) || 0)),
    remainingPlants: Math.max(0, Math.floor(Number(doc?.remainingPlants) || 0)),
    sowedQuantity: sowed,
    bookedPlants: cover,
    orderPlants: orderTotal,
    excessPlants: excess,
    linkedOrderIds: doc?.linkedOrderIds || [],
    isIrrelevant: Boolean(doc?.isIrrelevant),
    affectedSlot: {
      plantReadyDate: ready,
      bufferPlants: buffer,
      batchExpectedMortality: mortality,
      mortalityMovedToExcess: moved,
      noMortalityReserve: Boolean(doc?.noMortalityReserve),
      excessPlants: excess,
      bookedPlants: cover,
      batchPlantsSowed: sowed,
      isIrrelevant: Boolean(doc?.isIrrelevant),
    },
  };
}

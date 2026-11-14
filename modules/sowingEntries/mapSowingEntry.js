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
function latestTransferOf(doc) {
  const logs = Array.isArray(doc?.transferLog) ? doc.transferLog : [];
  const latest = logs.length ? logs[logs.length - 1] : null;
  if (!latest) return null;
  return {
    at: latest.at || null,
    plants: Math.max(0, Math.floor(Number(latest.plants) || 0)),
    direction: latest.direction || "",
    otherEntryId: latest.otherEntryId ? String(latest.otherEntryId) : "",
    otherRequestNumber: latest.otherRequestNumber || "",
  };
}

export function toSowingEntryListItem(doc, orderPlants = null) {
  const destroyed = Math.max(0, Math.floor(Number(doc?.destroyedPlants) || 0));
  const gross = Math.max(0, Math.floor(Number(doc?.plantsSowed) || 0));
  const sowed = Math.max(0, gross - destroyed);
  const view = { ...doc, plantsSowed: sowed };
  const cover = coverShownForEntry(view, orderPlants);
  const fields = excessFieldsForBatch(
    { ...view, orderCoveredPlants: cover },
    doc?.sowingBufferPct || 0
  );
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
    remainingPlants: Math.floor(Number(doc?.remainingPlants) || 0),
    destroyedPlants: destroyed,
    plantsTransferredOut: Math.max(0, Math.floor(Number(doc?.plantsTransferredOut) || 0)),
    plantsTransferredIn: Math.max(0, Math.floor(Number(doc?.plantsTransferredIn) || 0)),
    plantsMarkedSellable: Math.max(0, Math.floor(Number(doc?.plantsMarkedSellable) || 0)),
    latestTransfer: latestTransferOf(doc),
    sowedQuantity: sowed,
    bookedPlants: cover,
    orderPlants: orderTotal,
    excessPlants: excess,
    linkedOrderIds: doc?.linkedOrderIds || [],
    isIrrelevant: Boolean(doc?.isIrrelevant),
    entryKind: doc?.entryKind === "komb" || doc?.entryKind === "excess" ? doc.entryKind : "sowing",
    sourceEntryId: doc?.sourceEntryId ? String(doc.sourceEntryId) : "",
    affectedSlot: {
      plantReadyDate: ready,
      bufferPlants: buffer,
      batchExpectedMortality: mortality,
      mortalityMovedToExcess: moved,
      noMortalityReserve: Boolean(doc?.noMortalityReserve),
      excessPlants: excess,
      bookedPlants: cover,
      batchPlantsSowed: sowed,
      batchDestroyedPlants: destroyed,
      isIrrelevant: Boolean(doc?.isIrrelevant),
    },
  };
}

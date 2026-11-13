import { buildOrderSowingCoverBreakdown } from "../../utility/orderSowingCoverBreakdown.js";

const intQty = (v) => Math.max(0, Math.floor(Number(v) || 0));

function sameRequest(src, entry) {
  const requestId = String(entry?.sowingRequestId || "");
  const requestNumber = String(entry?.requestNumber || "");
  return (
    (requestId && String(src?.sowingRequestId || "") === requestId) ||
    (requestNumber && String(src?.requestNumber || "") === requestNumber)
  );
}

/** This entry's cover row: matching batch, or a request-level row with no batch. */
function onThisEntry(src, entry) {
  const batchId = String(entry?.sourceBatchId || "");
  const srcBatch = String(src?.batchId || "");
  if (batchId && srcBatch) return srcBatch === batchId;
  return sameRequest(src, entry);
}

function coverOffsetDays(deliveryDate, readyDateMeta) {
  if (!deliveryDate || !readyDateMeta) return null;
  const del = new Date(deliveryDate);
  const dmy = String(readyDateMeta).match(/^(\d{2})-(\d{2})-(\d{4})$/);
  const ready = dmy
    ? new Date(Number(dmy[3]), Number(dmy[2]) - 1, Number(dmy[1]), 12, 0, 0)
    : new Date(readyDateMeta);
  if (Number.isNaN(del.getTime()) || Number.isNaN(ready.getTime())) return null;
  const d0 = Date.UTC(del.getFullYear(), del.getMonth(), del.getDate());
  const r0 = Date.UTC(ready.getFullYear(), ready.getMonth(), ready.getDate());
  return Math.round((d0 - r0) / 86400000);
}

/**
 * Plants this entry took for every linked order.
 * Same split the order drawer shows. Null only when a linked order is missing
 * or none of them have a cover row.
 */
export function attributedOrderPlants(entry, orders) {
  const ids = entry?.linkedOrderIds || [];
  if (!ids.length) return null;
  const byId = new Map((orders || []).map((order) => [String(order?._id), order]));
  for (const id of ids) {
    if (!byId.get(String(id))) return null;
  }
  const taken = coverTakenByOrder(entry, orders);
  let sum = 0;
  let any = false;
  for (const id of ids) {
    const plants = taken.get(String(id)) || 0;
    if (plants > 0) any = true;
    sum += plants;
  }
  return any ? sum : null;
}

export function plantsFromThisEntry(order, entry) {
  const covers = Array.isArray(entry?.orderCovers) ? entry.orderCovers : [];
  if (covers.length) {
    const own = covers.find((row) => String(row?.orderId || "") === String(order?._id || ""));
    return own ? intQty(own.plants) : 0;
  }

  const sources = Array.isArray(order?.sowingCoverSources) ? order.sowingCoverSources : [];
  const fromSrc = sources
    .filter((src) => onThisEntry(src, entry))
    .reduce((sum, src) => sum + intQty(src?.plants), 0);
  if (fromSrc > 0) return fromSrc;

  const requestId = String(entry?.sowingRequestId || "");
  const held = (Array.isArray(order?.sowingPartialCover) ? order.sowingPartialCover : [])
    .filter(
      (row) =>
        String(row?.requestId || "") === requestId ||
        String(row?.sowingRequestId || "") === requestId
    )
    .reduce((sum, row) => sum + intQty(row?.plants), 0);
  if (held > 0) return held;

  const anySourceForRequest = sources.some((src) => sameRequest(src, entry));
  if (!anySourceForRequest && requestId && String(order?.sowingDoneRequestId || "") === requestId) {
    const others = sources.reduce((sum, src) => sum + intQty(src?.plants), 0);
    const booked = intQty(order?.numberOfPlants) + intQty(order?.additionalPlants);
    return Math.max(0, booked - others);
  }
  return 0;
}

function saleableOf(entry) {
  const sowed = intQty(entry?.plantsSowed ?? entry?.sowedQuantity);
  if (sowed < 1) return null;
  if (entry?.noMortalityReserve) return sowed;
  const moved = intQty(entry?.mortalityMovedToExcess);
  let buffer = null;
  if (entry?.bufferPlants != null && entry.bufferPlants !== "") buffer = intQty(entry.bufferPlants);
  else if (Number(entry?.sowingBufferPct) > 0) {
    buffer = Math.round((sowed * Number(entry.sowingBufferPct)) / 100);
  }
  if (buffer == null) return null;
  return Math.max(0, sowed - Math.max(0, buffer - moved));
}

function byDelivery(a, b) {
  const da = a?.deliveryDate ? new Date(a.deliveryDate).getTime() : Number.MAX_SAFE_INTEGER;
  const db = b?.deliveryDate ? new Date(b.deliveryDate).getTime() : Number.MAX_SAFE_INTEGER;
  if (da !== db) return da - db;
  const ca = a?.createdAt ? new Date(a.createdAt).getTime() : 0;
  const cb = b?.createdAt ? new Date(b.createdAt).getTime() : 0;
  if (ca !== cb) return ca - cb;
  return String(a?.orderId || "").localeCompare(String(b?.orderId || ""));
}

/**
 * One cover figure for the table and the order drawer.
 * Sources and partial rows win. A done-flag with no row still counts, but the
 * sum cannot pass expected ready — the last order stays partial.
 */
export function coverTakenByOrder(entry, orders) {
  const wanted = new Set((entry?.linkedOrderIds || []).map((id) => String(id)));
  const claims = (orders || [])
    .filter((order) => wanted.has(String(order?._id)))
    .map((order) => ({
      id: String(order._id),
      order,
      claim: plantsFromThisEntry(order, entry),
    }));
  const out = new Map();
  const saleable = saleableOf(entry);
  const sum = claims.reduce((total, row) => total + row.claim, 0);
  if (saleable == null || sum <= saleable) {
    for (const row of claims) out.set(row.id, row.claim);
    return out;
  }
  let pool = saleable;
  const sorted = [...claims].sort((a, b) => byDelivery(a.order, b.order));
  for (const row of sorted) {
    const give = Math.min(row.claim, pool);
    pool -= give;
    out.set(row.id, give);
  }
  return out;
}

/**
 * Orders this sowing has dispatched plants to.
 * The plant count is the dispatch record, separate from the cover link.
 */
export function dispatchedOrdersForEntry(entry, orders) {
  const byId = new Map((orders || []).map((order) => [String(order?._id), order]));
  const out = [];
  for (const row of entry?.dispatchedOrders || []) {
    const plants = intQty(row?.plants);
    if (plants < 1) continue;
    const id = String(row?.orderId || "");
    const order = byId.get(id);
    out.push({
      orderId: id,
      orderNumber: order?.orderId ?? "",
      farmerName: order?.farmer?.name || order?.name || "",
      plants,
      deliveryDate: order?.deliveryDate || null,
    });
  }
  return out;
}

/**
 * Orders stored on the sowing entry (`linkedOrderIds`), with plants taken
 * from each order's cover rows for this entry — not from the old year document.
 */
export function linkedOrdersForEntry(entry, orders) {
  const wanted = new Set((entry?.linkedOrderIds || []).map((id) => String(id)));
  if (!wanted.size) return [];
  const ready = entry?.plantReadyDate || "";
  const requestId = entry?.sowingRequestId ? String(entry.sowingRequestId) : "";
  const requestNumber = entry?.requestNumber || "";
  const taken = coverTakenByOrder(entry, orders);
  const out = [];

  for (const order of orders || []) {
    const id = String(order?._id || "");
    if (!wanted.has(id)) continue;
    const sources = Array.isArray(order?.sowingCoverSources) ? order.sowingCoverSources : [];
    const otherCoverSources = sources
      .filter((src) => !onThisEntry(src, entry) && intQty(src?.plants) > 0)
      .map((src) => ({
        requestNumber: src.requestNumber || "",
        sowingRequestId: src.sowingRequestId ? String(src.sowingRequestId) : "",
        plants: intQty(src.plants),
        offsetDays: src.offsetDays ?? null,
      }));
    const booked = intQty(order?.numberOfPlants) + intQty(order?.additionalPlants);
    const fromThisRaw = taken.has(id) ? taken.get(id) : plantsFromThisEntry(order, entry);
    const fromOthers = otherCoverSources.reduce((sum, src) => sum + src.plants, 0);
    const breakdown = buildOrderSowingCoverBreakdown({
      orderPlants: booked,
      fromThisRaw,
      fromOthers,
      sowingDone: Boolean(order?.sowingDone),
      coverKind: "fifo",
      otherCoverSources,
    });
    const orderStatus = String(order?.orderStatus || "").toUpperCase();
    out.push({
      orderId: id,
      orderNumber: order?.orderId ?? "",
      farmerName: order?.farmer?.name || order?.name || "",
      farmerMobile: order?.farmer?.mobileNumber || "",
      plants: booked,
      sowingDone: Boolean(order?.sowingDone),
      orderStatus,
      dispatched: ["DISPATCHED", "DISPATCH_PROCESS", "COMPLETED", "PARTIALLY_COMPLETED"].includes(
        orderStatus
      ),
      bookingDate: order?.orderBookingDate || order?.createdAt || null,
      deliveryDate: order?.deliveryDate || null,
      coverOffsetDays: coverOffsetDays(order?.deliveryDate, ready),
      ...breakdown,
      fromThisSowing: breakdown.sownHere,
      coverFromRequestNumber: requestNumber,
      coverFromRequestId: requestId,
    });
  }
  return out;
}

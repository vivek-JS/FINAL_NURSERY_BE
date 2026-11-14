/**
 * Source of truth for "how many plants this sowing covered":
 *   order.sowingCoverSources (+ excessAllocations / partial / sowingDoneRequestId)
 * Batch.orderCoveredPlants is a cache — must equal attributedCoverPlants(...).
 */

const intQty = (v) => Math.max(0, Math.floor(Number(v) || 0));

function sameRequest(src, { requestId, requestNumber } = {}) {
  return (
    (requestId && String(src?.sowingRequestId || "") === String(requestId)) ||
    (requestNumber && String(src?.requestNumber || "") === String(requestNumber))
  );
}

function orderPlantTotal(order) {
  return intQty(order?.numberOfPlants) + intQty(order?.additionalPlants);
}

/**
 * Plants this order took from a given sowing — mirrors enrichLinkedOrdersWithBatchCover.
 * Prefer explicit sources / alloc / partial.
 * inventDone=true (UI only): fall back to full order when sowingDoneRequestId matches.
 * inventDone=false (stamp reconcile): never invent — missing sources stay 0.
 */
export function plantsFromOrderForRequest(
  order,
  { requestId = null, requestNumber = "", excessAlloc = 0, inventDone = true } = {}
) {
  const sources = Array.isArray(order?.sowingCoverSources) ? order.sowingCoverSources : [];
  const fromSrc = sources
    .filter((s) => sameRequest(s, { requestId, requestNumber }))
    .reduce((s, x) => s + intQty(x?.plants), 0);
  if (fromSrc > 0) return fromSrc;

  const alloc = intQty(excessAlloc);
  if (alloc > 0) return alloc;

  const held = (Array.isArray(order?.sowingPartialCover) ? order.sowingPartialCover : [])
    .filter(
      (p) =>
        String(p?.requestId || "") === String(requestId) ||
        String(p?.sowingRequestId || "") === String(requestId)
    )
    .reduce((s, p) => s + intQty(p?.plants), 0);
  if (held > 0) return held;

  if (
    inventDone &&
    requestId &&
    String(order?.sowingDoneRequestId || "") === String(requestId)
  ) {
    const other = sources
      .filter((s) => !sameRequest(s, { requestId, requestNumber }))
      .reduce((s, x) => s + intQty(x?.plants), 0);
    return Math.max(0, orderPlantTotal(order) - other);
  }

  return 0;
}

export function excessAllocByOrderId(batch) {
  const map = new Map();
  for (const a of batch?.excessAllocations || []) {
    const id = String(a?.orderId || "");
    if (!id) continue;
    map.set(id, (map.get(id) || 0) + intQty(a?.plants));
  }
  return map;
}

/**
 * Attributed cover for a sowing batch = sum of per-order plants from this request.
 */
export function attributedCoverPlants({
  requestId = null,
  requestNumber = "",
  batch = null,
  orders = [],
  inventDone = true,
} = {}) {
  const allocMap = excessAllocByOrderId(batch);
  const seen = new Set();
  let sum = 0;

  for (const order of orders || []) {
    const id = String(order?._id || order?.orderId || "");
    if (!id || seen.has(id)) continue;
    seen.add(id);
    sum += plantsFromOrderForRequest(order, {
      requestId,
      requestNumber,
      excessAlloc: allocMap.get(id) || 0,
      inventDone,
    });
  }

  // Excess-only rows on the batch that may not be in `orders`
  for (const [orderId, plants] of allocMap) {
    if (seen.has(orderId) || plants < 1) continue;
    sum += plants;
  }

  return sum;
}

/** Sum sownHere from already-enriched linked orders (drawer total). */
export function coverFromEnrichedOrders(linkedOrders = []) {
  return (linkedOrders || []).reduce(
    (s, o) =>
      s +
      intQty(o?.sownHere ?? o?.fromThisSowing ?? o?.coveredPlants),
    0
  );
}

/** True when stamped batch cover disagrees with order refs. */
export function coverStampDrift(batch, attributed) {
  const stamped = intQty(batch?.orderCoveredPlants);
  const attr = intQty(attributed);
  return stamped !== attr ? { stamped, attributed: attr, delta: stamped - attr } : null;
}

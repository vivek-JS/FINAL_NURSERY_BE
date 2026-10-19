const toQty = (v) => Math.max(0, Math.floor(Number(v) || 0));
const idStr = (v) => (v == null || v === "" ? "" : String(v?._id ?? v));

export function orderPlantTotal(order) {
  return toQty(order?.numberOfPlants) + toQty(order?.additionalPlants);
}

export function orderPartialHeld(order) {
  const rows = Array.isArray(order?.sowingPartialCover)
    ? order.sowingPartialCover
    : order?.sowingPartialCover?.plants
      ? [order.sowingPartialCover]
      : [];
  return rows.reduce((s, r) => s + toQty(r.plants), 0);
}

export function orderPlantRemaining(order) {
  return Math.max(0, orderPlantTotal(order) - orderPartialHeld(order));
}

/**
 * FIFO cover: only fully covered orders are sown.
 * A leftover that cannot fill the next order stays excess (not a partial hold).
 * Unfilled orders go to the next sowing request at their full remaining qty.
 */
export function planOrderSowCover({ plantsSowed, orders = [] }) {
  let left = toQty(plantsSowed);
  const full = [];
  const waiting = [];

  for (const o of orders) {
    const remaining = orderPlantRemaining(o);
    if (remaining < 1) continue;
    const oid = o._id ?? o.orderId;
    const held = orderPartialHeld(o);
    if (left >= remaining) {
      full.push({
        orderId: oid,
        plants: remaining,
        totalCovered: held + remaining,
      });
      left -= remaining;
    } else {
      waiting.push({ orderId: oid, remaining });
    }
  }

  return {
    full,
    partial: null,
    waiting,
    excess: left,
    incomplete: waiting.length > 0,
    orderPlantsCovered: toQty(plantsSowed) - left,
  };
}

export function applyIncompleteRequestRelease(request, plan, { sowedAt } = {}) {
  const marked = (plan.full || []).map((f) => f.orderId).filter(Boolean);
  if (!plan.incomplete) {
    if (marked.length) request.linkedOrderIds = marked;
    return { incomplete: false, linkedOrderIds: request.linkedOrderIds, uncoveredOrderIds: [] };
  }
  const uncovered = (plan.waiting || []).map((w) => w.orderId).filter(Boolean);
  request.sowingIncomplete = true;
  request.sowingCompleted = true;
  request.sowingCompletedDate = sowedAt instanceof Date ? sowedAt : new Date();
  request.remainingSowingNeeded = 0;
  request.linkedOrderIds = marked;
  request.uncoveredOrderIds = uncovered;
  return { incomplete: true, linkedOrderIds: marked, uncoveredOrderIds: uncovered };
}

export function idList(ids) {
  return [...new Set((ids || []).map(idStr).filter(Boolean))];
}

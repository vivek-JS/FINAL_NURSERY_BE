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
 * FIFO cover: fully covered orders, one partial hold, the rest waiting.
 * Excess = plants left after every remaining order is fully covered.
 */
export function planOrderSowCover({ plantsSowed, orders = [] }) {
  let left = toQty(plantsSowed);
  const full = [];
  let partial = null;
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
    } else if (left > 0 && !partial) {
      partial = {
        orderId: oid,
        addPlants: left,
        totalCovered: held + left,
        remainingNeed: remaining,
      };
      left = 0;
    } else {
      waiting.push({ orderId: oid, remaining });
    }
  }

  return {
    full,
    partial,
    waiting,
    excess: left,
    incomplete: Boolean(partial || waiting.length),
    orderPlantsCovered: toQty(plantsSowed) - left,
  };
}

export function applyIncompleteRequestRelease(request, plan, { sowedAt } = {}) {
  const marked = (plan.full || []).map((f) => f.orderId).filter(Boolean);
  if (!plan.incomplete) {
    if (marked.length) request.linkedOrderIds = marked;
    return { incomplete: false, linkedOrderIds: request.linkedOrderIds, uncoveredOrderIds: [] };
  }
  const uncovered = [
    ...(plan.partial?.orderId ? [plan.partial.orderId] : []),
    ...(plan.waiting || []).map((w) => w.orderId),
  ].filter(Boolean);
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

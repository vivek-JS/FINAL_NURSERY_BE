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

/** Plants already stamped on sowingCoverSources (source of truth). */
export function orderCoveredFromSources(order) {
  const sources = Array.isArray(order?.sowingCoverSources) ? order.sowingCoverSources : [];
  return sources.reduce((s, row) => s + toQty(row?.plants), 0);
}

function coverRequestKey(row, fallback) {
  const id = row?.sowingRequestId || row?.requestId || row?.requestNumber;
  return id != null && id !== "" ? String(id?._id ?? id) : fallback;
}

/**
 * Plants already attributed. Covers from different requests add.
 * The same request on both a source and a partial hold is counted once (the source).
 */
export function orderAlreadyCovered(order) {
  const sources = Array.isArray(order?.sowingCoverSources) ? order.sowingCoverSources : [];
  const sourceKeys = new Set();
  let covered = 0;
  sources.forEach((row, index) => {
    sourceKeys.add(coverRequestKey(row, `source:${index}`));
    covered += toQty(row?.plants);
  });
  const partials = Array.isArray(order?.sowingPartialCover)
    ? order.sowingPartialCover
    : order?.sowingPartialCover?.plants
      ? [order.sowingPartialCover]
      : [];
  partials.forEach((row, index) => {
    const key = coverRequestKey(row, `partial:${index}`);
    if (sourceKeys.has(key)) return;
    covered += toQty(row?.plants);
  });
  return covered;
}

/** Mongo expression: same rule as orderAlreadyCovered. */
export function sowingCoveredPlantsExpr() {
  const sources = { $ifNull: ["$sowingCoverSources", []] };
  return {
    $add: [
      {
        $sum: {
          $map: {
            input: sources,
            as: "s",
            in: { $ifNull: ["$$s.plants", 0] },
          },
        },
      },
      {
        $sum: {
          $map: {
            input: {
              $filter: {
                input: { $ifNull: ["$sowingPartialCover", []] },
                as: "p",
                cond: {
                  $not: {
                    $in: [
                      "$$p.requestId",
                      {
                        $map: {
                          input: sources,
                          as: "s",
                          in: "$$s.sowingRequestId",
                        },
                      },
                    ],
                  },
                },
              },
            },
            as: "p",
            in: { $ifNull: ["$$p.plants", 0] },
          },
        },
      },
    ],
  };
}

export function orderPlantRemaining(order) {
  // The done flag is not cover. Remaining is the order minus plants actually stamped.
  return Math.max(0, orderPlantTotal(order) - orderAlreadyCovered(order));
}

/**
 * Plants already attributed to every request except this one.
 * Used when restamping this request's row so the new total can be checked.
 */
export function orderCoveredExceptRequest(order, requestId) {
  const req = requestId == null || requestId === "" ? "" : String(requestId?._id ?? requestId);
  const sources = Array.isArray(order?.sowingCoverSources) ? order.sowingCoverSources : [];
  const sourceKeys = new Set();
  let covered = 0;
  sources.forEach((row, index) => {
    const key = coverRequestKey(row, `source:${index}`);
    if (req && key === req) return;
    sourceKeys.add(key);
    covered += toQty(row?.plants);
  });
  const partials = Array.isArray(order?.sowingPartialCover)
    ? order.sowingPartialCover
    : order?.sowingPartialCover?.plants
      ? [order.sowingPartialCover]
      : [];
  partials.forEach((row, index) => {
    const key = coverRequestKey(row, `partial:${index}`);
    if ((req && key === req) || sourceKeys.has(key)) return;
    covered += toQty(row?.plants);
  });
  return covered;
}

/**
 * Mongo $expr: still short.
 * A done flag does not hide a short order, including one with no cover rows.
 */
export function sowingStillShortExpr() {
  const booked = {
    $add: [
      { $ifNull: ["$numberOfPlants", 0] },
      { $ifNull: ["$additionalPlants", 0] },
    ],
  };
  const covered = sowingCoveredPlantsExpr();
  return {
    $and: [{ $gt: [booked, 0] }, { $gt: [booked, covered] }],
  };
}

/** Plants still uncovered across every request. A done flag does not hide a short order. */
export function sowingStillNeedsMatch() {
  return { $expr: sowingStillShortExpr() };
}

/** Only mark sowingDone when attributed cover fully meets the order. */
export function canMarkOrderSowingDone(order, additionalCover = 0) {
  const need = orderPlantTotal(order);
  if (need < 1) return false;
  return orderAlreadyCovered(order) + toQty(additionalCover) >= need;
}

/**
 * FIFO cover: fully covered orders are sown.
 * Leftover plants that cannot fill the next order are a partial hold on that
 * order. Remaining packing is booked minus that hold. Later waiting orders
 * go to the next request at their leftover remaining.
 */
export function planOrderSowCover({ plantsSowed, orders = [] }) {
  let left = toQty(plantsSowed);
  const full = [];
  const waiting = [];
  let partial = null;

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
        remaining: remaining - left,
        totalCovered: held + left,
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
    incomplete: Boolean(partial) || waiting.length > 0,
    orderPlantsCovered: toQty(plantsSowed) - left,
  };
}

/**
 * If mortality leftover can finish the last started order, do that.
 * Does not start the next waiting order from mortality.
 */
export function fillLastPartialFromBuffer(plan, bufferLeft = 0) {
  const fill = toQty(bufferLeft);
  if (!plan?.partial || fill < 1) return plan;
  const need = toQty(plan.partial.remaining);
  if (need < 1 || need > fill) return plan;
  const waiting = plan.waiting || [];
  return {
    ...plan,
    full: [
      ...(plan.full || []),
      {
        orderId: plan.partial.orderId,
        plants: toQty(plan.partial.addPlants) + need,
        totalCovered: toQty(plan.partial.totalCovered) + need,
      },
    ],
    partial: null,
    waiting,
    incomplete: waiting.length > 0,
    orderPlantsCovered: toQty(plan.orderPlantsCovered) + need,
  };
}

export function applyIncompleteRequestRelease(request, plan, { sowedAt } = {}) {
  const marked = (plan.full || []).map((f) => f.orderId).filter(Boolean);
  if (!plan.incomplete) {
    if (marked.length) request.linkedOrderIds = marked;
    return { incomplete: false, linkedOrderIds: request.linkedOrderIds, uncoveredOrderIds: [] };
  }
  const uncovered = [
    plan.partial?.orderId,
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

/** Linked plus leftover uncovered — FIFO must see the partial/waiting orders too. */
export function requestCoverOrderIds(request) {
  return idList([
    ...(request?.linkedOrderIds || []),
    ...(request?.uncoveredOrderIds || []),
  ]);
}

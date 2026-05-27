/**
 * Add MIS drawer fields: dispatchedDate, completedDate, bucketEventAt.
 */

function transitionTimestamp(change) {
  return change?.createdAt ?? change?.changedAt ?? null;
}

/** Earliest statusChanges entry for a given newStatus. */
export function firstTransitionDate(order, newStatus) {
  const want = String(newStatus || "").toUpperCase();
  const changes = Array.isArray(order?.statusChanges) ? order.statusChanges : [];
  let earliest = null;
  for (const sc of changes) {
    if (String(sc?.newStatus || "").toUpperCase() !== want) continue;
    const t = transitionTimestamp(sc);
    if (!t) continue;
    const d = new Date(t);
    if (Number.isNaN(d.getTime())) continue;
    if (!earliest || d < earliest) earliest = d;
  }
  return earliest;
}

/**
 * @param {object} order lean order document
 * @param {{ bucket?: string, bucketEventAt?: Date|string|null }} opts
 */
export function enrichMisOrderRow(order, { bucket, bucketEventAt } = {}) {
  const dispatchedDate = firstTransitionDate(order, "DISPATCHED");
  const completedDate = firstTransitionDate(order, "COMPLETED");

  let eventAt = bucketEventAt ? new Date(bucketEventAt) : null;
  if (!eventAt || Number.isNaN(eventAt.getTime())) {
    if (bucket === "dispatched") eventAt = dispatchedDate;
    else if (bucket === "completed") eventAt = completedDate;
  }

  return {
    ...order,
    dispatchedDate: dispatchedDate || null,
    completedDate: completedDate || null,
    bucketEventAt: eventAt || null,
  };
}

export function enrichMisOrderList(orders, bucket, eventAtById) {
  return (orders || []).map((order) => {
    const id = order?._id != null ? String(order._id) : "";
    return enrichMisOrderRow(order, {
      bucket,
      bucketEventAt: eventAtById?.get?.(id) ?? order?.bucketEventAt,
    });
  });
}

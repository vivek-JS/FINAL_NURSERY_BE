/**
 * Map active sowing requests → orders.
 * Explicit linkedOrderIds win. Slot-only requests (legacy / card-wide with
 * empty linkedOrderIds) mark every order in those slots.
 */
export function buildOrderRequestLookup(activeReqs) {
  const byOrderId = new Map();
  const bySlotId = new Map();
  for (const req of activeReqs || []) {
    const meta = {
      requestNumber: req.requestNumber,
      status: req.status,
    };
    const orderIds = req.linkedOrderIds || [];
    if (orderIds.length) {
      for (const oid of orderIds) {
        const key = String(oid);
        if (!byOrderId.has(key)) byOrderId.set(key, meta);
      }
      continue;
    }
    for (const slotId of req.linkedSlotIds || []) {
      const key = String(slotId);
      if (!bySlotId.has(key)) bySlotId.set(key, meta);
    }
  }
  return { byOrderId, bySlotId };
}

export function lookupOrderRequest(order, lookup) {
  if (!lookup) return null;
  const byId = lookup.byOrderId?.get(String(order?._id || order?.orderId));
  if (byId) return byId;
  const slot = order?.bookingSlot;
  if (!slot) return null;
  return lookup.bySlotId?.get(String(slot)) || null;
}

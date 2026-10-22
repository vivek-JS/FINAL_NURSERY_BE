const toQty = (v) => Math.max(0, Math.floor(Number(v) || 0));
const idStr = (v) => (v == null || v === "" ? "" : String(v?._id ?? v));

export const orderPlants = (o) => toQty(o?.numberOfPlants) + toQty(o?.additionalPlants);

function batchForRequest(batchIndex, reqId, orderId) {
  if (!reqId) return null;
  const candidates = [...batchIndex.values()].filter((e) => idStr(e.batch.sowingRequestId) === reqId);
  if (!candidates.length) return null;
  const oid = idStr(orderId);
  return (
    candidates.find((e) => (e.batch.linkedOrderIds || []).some((x) => idStr(x) === oid)) ||
    candidates[0]
  );
}

/**
 * Batches an order's plants were sown into before any dispatch relink:
 * partial holds first, active excess cover sources next, else the batch of its own sowing request.
 */
export function baseOrderLinks(order, batchIndex) {
  const partials = Array.isArray(order?.sowingPartialCover) ? order.sowingPartialCover : [];
  const links = [];
  let held = 0;
  for (const p of partials) {
    const n = toQty(p.plants);
    if (n < 1) continue;
    const pick = batchForRequest(batchIndex, idStr(p.requestId), order._id);
    if (!pick) continue;
    links.push({ slotId: pick.slotId, batchId: idStr(pick.batch._id), plants: n });
    held += n;
  }

  const covers = order?.sowingCoverReversedAt ? [] : order?.sowingCoverSources || [];
  if (covers.length) {
    for (const s of covers) {
      const link = {
        slotId: idStr(s.moved ? s.destSlotId : s.slotId),
        batchId: idStr(s.moved ? s.destBatchId : s.batchId),
        plants: toQty(s.plants),
      };
      if (link.batchId && link.plants > 0) links.push(link);
    }
    return links;
  }

  const reqId = idStr(order?.sowingDoneRequestId);
  if (reqId) {
    const pick = batchForRequest(batchIndex, reqId, order._id);
    const plants =
      held > 0
        ? order.sowingDone
          ? Math.max(0, orderPlants(order) - held)
          : 0
        : orderPlants(order);
    if (pick && plants > 0) {
      links.push({ slotId: pick.slotId, batchId: idStr(pick.batch._id), plants });
    }
  }
  return links;
}

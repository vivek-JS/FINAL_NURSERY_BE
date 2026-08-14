/**
 * Match a PO line to a GRN line (classic product OR Ram Agri crop/variety).
 * Never call .toString() on null product — Auto GRN Ram Agri lines have product=null.
 */
export function toIdString(v) {
  if (v == null) return "";
  if (typeof v === "object" && v._id) return String(v._id);
  return String(v);
}

/**
 * @param {object[]} poItems
 * @param {object} grnItem
 * @returns {object|null}
 */
export function findPoItemForGrnLine(poItems, grnItem) {
  if (!Array.isArray(poItems) || !grnItem) return null;

  // 1) Explicit link when GRN item carries poItem
  const poItemRef = grnItem.poItem?._id || grnItem.poItem;
  if (poItemRef) {
    const byId = poItems.find((it) => String(it._id) === String(poItemRef));
    if (byId) return byId;
  }

  // 2) Ram Agri: crop + variety (+ optional slot)
  const agri =
    grnItem.isRamAgriProduct ||
    grnItem.ramAgriCropId ||
    grnItem.ramAgriVarietyId;
  if (agri) {
    const crop = toIdString(grnItem.ramAgriCropId);
    const variety = toIdString(grnItem.ramAgriVarietyId);
    const slot = toIdString(grnItem.slotId);
    const match = poItems.find((it) => {
      if (!it.isRamAgriProduct && !it.ramAgriCropId) return false;
      if (crop && toIdString(it.ramAgriCropId) !== crop) return false;
      if (variety && toIdString(it.ramAgriVarietyId) !== variety) return false;
      if (slot && toIdString(it.slotId) && toIdString(it.slotId) !== slot) return false;
      return true;
    });
    if (match) return match;
  }

  // 3) Classic product id
  const productId = toIdString(grnItem.product);
  if (productId) {
    return (
      poItems.find((it) => {
        if (it.isRamAgriProduct) return false;
        return toIdString(it.product) === productId;
      }) || null
    );
  }

  return null;
}

/**
 * Apply accepted GRN quantities onto PO items and set PO status.
 * @returns {{ updated: number, status: string }}
 */
export function applyGrnAcceptedQtyToPurchaseOrder(po, grnItems) {
  if (!po?.items?.length) return { updated: 0, status: po?.status || "" };
  let updated = 0;
  for (const grnItem of grnItems || []) {
    const qty = Number(grnItem.acceptedQuantity) || 0;
    if (!(qty > 0)) continue;
    const poItem = findPoItemForGrnLine(po.items, grnItem);
    if (!poItem) continue;
    poItem.receivedQuantity = (Number(poItem.receivedQuantity) || 0) + qty;
    updated += 1;
  }
  const allReceived = po.items.every(
    (item) => (Number(item.receivedQuantity) || 0) >= (Number(item.quantity) || 0)
  );
  const anyReceived = po.items.some((item) => (Number(item.receivedQuantity) || 0) > 0);
  if (allReceived) po.status = "received";
  else if (anyReceived) po.status = "partial_received";
  return { updated, status: po.status };
}

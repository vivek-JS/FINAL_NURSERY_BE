export function normalizeIdString(value) {
  if (value == null) return "";
  return String(value?._id || value).trim();
}

export function getOrderIdStrings(orderIds) {
  if (!Array.isArray(orderIds)) return [];
  return orderIds.map(normalizeIdString).filter(Boolean);
}

export function scopedOrderIdsForDispatch(dispatchDoc, visibleOrderIdSet = null) {
  const orderIds = getOrderIdStrings(dispatchDoc?.orderIds);
  if (!visibleOrderIdSet) return orderIds;
  return orderIds.filter((id) => visibleOrderIdSet.has(id));
}

export function filterDispatchesByVisibleOrders(dispatchDocs, visibleOrderIdSet = null) {
  if (!visibleOrderIdSet) return dispatchDocs;
  return dispatchDocs.filter(
    (dispatchDoc) => scopedOrderIdsForDispatch(dispatchDoc, visibleOrderIdSet).length > 0
  );
}

export function sumPlantDetails(plantsDetails) {
  if (!Array.isArray(plantsDetails)) return 0;
  return plantsDetails.reduce(
    (sum, detail) => sum + (Number(detail?.totalPlants ?? detail?.quantity) || 0),
    0
  );
}

export function sumDispatchPlantsForScope(dispatchDoc, visibleOrderIdSet = null) {
  const allOrderIds = getOrderIdStrings(dispatchDoc?.orderIds);
  const visibleOrderIds = scopedOrderIdsForDispatch(dispatchDoc, visibleOrderIdSet);
  const allDispatchOrdersVisible =
    !visibleOrderIdSet || visibleOrderIds.length === allOrderIds.length;

  if (!visibleOrderIdSet || allDispatchOrdersVisible) {
    return sumPlantDetails(dispatchDoc?.plantsDetails);
  }

  const details = Array.isArray(dispatchDoc?.orderDispatchDetails)
    ? dispatchDoc.orderDispatchDetails
    : [];

  if (!details.length) return 0;

  return details.reduce((sum, detail) => {
    const orderId = normalizeIdString(detail?.orderId);
    if (!visibleOrderIdSet.has(orderId)) return sum;
    return sum + (Number(detail?.dispatchQuantity) || 0);
  }, 0);
}

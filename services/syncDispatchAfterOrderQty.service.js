import mongoose from "mongoose";
import Dispatch from "../models/dispatch.model.js";
import Order from "../models/order.model.js";
import { rebuildDispatchTargets } from "./dispatchTargetBuilder.service.js";
import { DISPATCH_SHED_ALLOWED_STATUSES } from "./secondaryVehicleLoad.service.js";
import { syncOrderVehicleLoadedFlag } from "./dispatchPostLoadFinalize.service.js";
import { orderStatusFromRemaining } from "../utility/dispatchOrderStatus.util.js";

/**
 * After office +qty on an order that is already on a shed vehicle, bump that
 * dispatch line (and crates) so Flutter "Load remaining" unlocks — same outcome
 * as DispatchedForm "Edit — load more" + save.
 *
 * Consumes the order.remainingPlants delta into this dispatch (mirrors updateDispatch).
 */
export async function syncDispatchAfterOrderQtyIncrease({
  order,
  previousNumberOfPlants,
  nextNumberOfPlants,
  userId = null,
  session = null,
}) {
  const prev = Math.floor(Number(previousNumberOfPlants) || 0);
  const next = Math.floor(Number(nextNumberOfPlants) || 0);
  const delta = next - prev;
  if (delta < 1 || !order?._id) return null;

  const dispatchId = order.currentDispatchId;
  if (!dispatchId || !mongoose.isValidObjectId(String(dispatchId))) return null;

  const q = Dispatch.findById(dispatchId);
  if (session) q.session(session);
  const dispatch = await q;
  if (!dispatch) return null;
  if (!DISPATCH_SHED_ALLOWED_STATUSES.includes(String(dispatch.transportStatus || ""))) {
    return null;
  }

  const oid = String(order._id);
  const rowIdx = (dispatch.orderDispatchDetails || []).findIndex(
    (d) => String(d.orderId) === oid
  );
  if (rowIdx < 0) return null;

  const row = dispatch.orderDispatchDetails[rowIdx];
  const oldQty = Math.max(0, Math.floor(Number(row.dispatchQuantity) || 0));
  const shedLoaded = Math.max(0, Math.floor(Number(row.shedLoadedQuantity) || 0));
  const newQty = oldQty + delta;
  if (newQty < shedLoaded) return null;

  const officeEditNow = new Date();
  const originalQty =
    row.originalDispatchQuantity != null &&
    Number.isFinite(Number(row.originalDispatchQuantity))
      ? Number(row.originalDispatchQuantity)
      : oldQty;

  const orderQ = Order.findById(order._id);
  if (session) orderQ.session(session);
  const fresh = await orderQ;
  if (!fresh) return null;

  const hist = Array.isArray(fresh.dispatchHistory) ? fresh.dispatchHistory : [];
  const nextHist = hist.map((h) => {
    const plain = h?.toObject ? h.toObject() : { ...h };
    if (String(plain.dispatchId || "") !== String(dispatch._id)) return plain;
    return {
      ...plain,
      quantity: newQty,
    };
  });
  const hasHist = nextHist.some(
    (h) => String(h.dispatchId || "") === String(dispatch._id)
  );
  if (!hasHist) {
    nextHist.push({
      date: officeEditNow,
      quantity: newQty,
      dispatchId: dispatch._id,
      processedBy: userId || null,
      driverName: dispatch.driverName || "",
      vehicleName: dispatch.vehicleName || "",
    });
  }

  // Prefer history math over stored remaining (stored can be stale after +qty on loaded orders).
  const orderTotal =
    (Number(fresh.numberOfPlants) || 0) + (Number(fresh.additionalPlants) || 0);
  const bookedOnDispatches = nextHist.reduce(
    (s, h) => s + (Math.max(0, Number(h.quantity) || 0)),
    0
  );
  const newRemaining = Math.max(0, orderTotal - bookedOnDispatches);
  for (const h of nextHist) {
    if (String(h.dispatchId || "") === String(dispatch._id)) {
      h.remainingAfterDispatch = newRemaining;
    }
  }
  const newStatus = orderStatusFromRemaining(fresh, newRemaining);

  fresh.remainingPlants = newRemaining;
  fresh.orderStatus = newStatus;
  fresh.dispatchHistory = nextHist;
  await fresh.save({ session, validateBeforeSave: true });

  const nextDetails = (dispatch.orderDispatchDetails || []).map((d, i) => {
    if (i !== rowIdx) return d?.toObject ? d.toObject() : { ...d };
    const plain = d?.toObject ? d.toObject() : { ...d };
    return {
      ...plain,
      orderId: plain.orderId,
      dispatchQuantity: newQty,
      originalDispatchQuantity: originalQty,
      lastOfficeQtyDelta: delta,
      lastOfficeEditedAt: officeEditNow,
      shedLoadedQuantity: shedLoaded,
      remainingAfterDispatch: newRemaining,
    };
  });

  const plainDispatch = dispatch.toObject ? dispatch.toObject() : { ...dispatch };
  const dispatchRequest = {
    ...plainDispatch,
    orderIds: (plainDispatch.orderIds || []).map((id) => id),
    orderDispatchDetails: nextDetails,
    // Empty → rebuild plantsDetails + crates from order lines (bumps vehicle need).
    plantsDetails: [],
  };
  await rebuildDispatchTargets({ dispatchRequest, session });

  dispatch.orderDispatchDetails = dispatchRequest.orderDispatchDetails;
  dispatch.plantsDetails = dispatchRequest.plantsDetails;
  dispatch.lastOfficeEditedAt = officeEditNow;
  await dispatch.save({ session, validateBeforeSave: true });

  await syncOrderVehicleLoadedFlag({
    session,
    orderId: oid,
    dispatchDoc: dispatch,
  });

  const orderCode =
    fresh.orderId != null
      ? String(fresh.orderId)
      : fresh.publicOrderCode || oid.slice(-4);

  return {
    dispatch,
    qtyDeltas: [
      {
        orderId: oid,
        orderCode,
        delta,
        oldQty,
        newQty,
      },
    ],
    editedAt: officeEditNow,
  };
}

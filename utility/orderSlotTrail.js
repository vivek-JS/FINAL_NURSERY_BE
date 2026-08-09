import mongoose from "mongoose";
import Order from "../models/order.model.js";
import { SLOT_TRAIL_ACTIONS, getSlotTrailActivityName } from "../constants/slotTrailActions.js";
import {
  appendTransferSlotTrail,
  buildSlotSnapshot,
  computeAvailableFromBooked,
  findSlotSubdocumentById,
} from "./slotTransferTrail.js";

const parseNum = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/** Customer labels for slot trail (book-for + booking farmer). */
export function resolveOrderTrailCustomer(order) {
  if (!order || typeof order !== "object") {
    return {
      displayName: null,
      farmerName: null,
      orderForName: null,
      bookingFarmerName: null,
      farmerMobile: null,
      orderForMobile: null,
    };
  }

  const farmer = order.farmer && typeof order.farmer === "object" ? order.farmer : null;
  const of =
    order.orderFor && typeof order.orderFor === "object" && !Array.isArray(order.orderFor)
      ? order.orderFor
      : null;

  const bookingName = farmer?.name ? String(farmer.name).trim() : "";
  const orderForName = of?.name ? String(of.name).trim() : "";
  const displayName = orderForName
    ? `${orderForName} · Booking: ${bookingName || "Unknown"}`
    : bookingName || null;

  const farmerMobile = farmer?.mobileNumber ?? null;
  const orderForMobile =
    of?.mobileNumber != null && of.mobileNumber !== "" && of.mobileNumber !== 0
      ? of.mobileNumber
      : null;

  return {
    displayName,
    farmerName: bookingName || null,
    orderForName: orderForName || null,
    bookingFarmerName: bookingName || null,
    farmerMobile,
    orderForMobile,
  };
}

function computeAfterSnapshot(beforeSnap, qty, direction, { isSowingAllowed, affectsAvailable }) {
  const delta = direction === "book" ? parseNum(qty) : -parseNum(qty);
  const afterSlot = {
    totalBookedPlants: parseNum(beforeSnap.totalBookedPlants) + delta,
    totalPlants: parseNum(beforeSnap.totalPlants),
    availablePlants: parseNum(beforeSnap.availablePlants),
    primarySowed: parseNum(beforeSnap.primarySowed),
    officeSowed: parseNum(beforeSnap.officeSowed),
    plantsSowed: parseNum(beforeSnap.plantsSowed),
    excessivePlants: parseNum(beforeSnap.excessivePlants),
    actualPlants: parseNum(beforeSnap.actualPlants),
    closingStock: parseNum(beforeSnap.closingStock),
    inProgressCount: parseNum(beforeSnap.inProgressCount),
  };

  if (affectsAvailable && !isSowingAllowed) {
    afterSlot.availablePlants = parseNum(beforeSnap.availablePlants) - delta;
  } else if (!affectsAvailable || isSowingAllowed) {
    afterSlot.availablePlants = computeAvailableFromBooked(afterSlot);
  }

  return buildSlotSnapshot(afterSlot);
}

/**
 * Append slot trail when order booking counters change (book / release / cancel).
 * Call AFTER PlantSlot $inc so before snapshot is read pre-update from caller,
 * or pass explicit beforeSnap when already captured.
 */
export async function appendOrderSlotTrail({
  slotId,
  orderId,
  quantity,
  direction,
  performedBy = null,
  session = null,
  isSowingAllowed = false,
  affectsAvailable = true,
  beforeSnap = null,
  reason = null,
  notes = null,
}) {
  const qty = parseNum(quantity);
  if (!slotId || !orderId || qty <= 0) return;

  const found = beforeSnap ? null : await findSlotSubdocumentById(slotId, session);
  const before = beforeSnap || (found?.slot ? buildSlotSnapshot(found.slot) : null);
  if (!before) return;

  const after = computeAfterSnapshot(before, qty, direction, { isSowingAllowed, affectsAvailable });

  let order = null;
  try {
    let q = Order.findById(orderId)
      .select("orderId orderFor farmer")
      .populate("farmer", "name mobileNumber")
      .lean();
    if (session) q = q.session(session);
    order = await q;
  } catch {
    order = null;
  }

  const customer = resolveOrderTrailCustomer(order);
  const action =
    direction === "book" ? SLOT_TRAIL_ACTIONS.ORDER_BOOKED : SLOT_TRAIL_ACTIONS.ORDER_CANCELLED;

  const orderNum = order?.orderId ?? null;
  const defaultReason =
    direction === "book"
      ? `Order #${orderNum ?? "—"} booked — ${qty.toLocaleString()} plants`
      : `Order #${orderNum ?? "—"} released — ${qty.toLocaleString()} plants`;

  await appendTransferSlotTrail({
    slotId,
    action,
    quantity: qty,
    performedBy,
    notes:
      notes ||
      (customer.displayName
        ? `${customer.displayName} · ${qty.toLocaleString()} plants`
        : `${qty.toLocaleString()} plants`),
    reason: reason || defaultReason,
    metadata: {
      orderNumber: orderNum,
      customerDisplayName: customer.displayName,
      farmerName: customer.farmerName,
      orderForName: customer.orderForName,
      bookingFarmerName: customer.bookingFarmerName,
      farmerMobile: customer.farmerMobile,
      orderForMobile: customer.orderForMobile,
      bookedDelta: direction === "book" ? qty : -qty,
    },
    before,
    after,
    orderId: new mongoose.Types.ObjectId(String(orderId)),
    bufferPercentage: 0,
    bufferAmount: 0,
    session,
  });
}

export async function captureSlotSnapshot(slotId, session) {
  const found = await findSlotSubdocumentById(slotId, session);
  return found?.slot ? buildSlotSnapshot(found.slot) : null;
}

export { getSlotTrailActivityName };

import mongoose from "mongoose";
import PlantSlot from "../models/slots.model.js";
import { isSlotExpiredByEndDay } from "../services/pastDueSlotRollover.service.js";

const OVERRIDE_ROLES = new Set(["SUPER_ADMIN", "SUPERADMIN"]);

export function canOverrideExpiredSlotBooking(user) {
  const role = String(user?.role || user?.jobTitle || "").toUpperCase();
  return OVERRIDE_ROLES.has(role);
}

export async function findSlotRowByBookingSlotId(bookingSlotId, session = null) {
  if (!bookingSlotId || !mongoose.isValidObjectId(String(bookingSlotId))) {
    return null;
  }
  let q = PlantSlot.findOne(
    { "subtypeSlots.slots._id": bookingSlotId },
    { "subtypeSlots.$": 1 }
  );
  if (session) q = q.session(session);
  const doc = await q.lean();
  const slots = doc?.subtypeSlots?.[0]?.slots;
  if (!Array.isArray(slots)) return null;
  return (
    slots.find((s) => String(s._id) === String(bookingSlotId)) || null
  );
}

/** Block new bookings / slot subtract on expired delivery windows (Super Admin may override). */
export async function assertBookingSlotOpenForNewAllocation(
  bookingSlotId,
  user,
  session = null
) {
  if (!bookingSlotId || canOverrideExpiredSlotBooking(user)) return;
  const slot = await findSlotRowByBookingSlotId(bookingSlotId, session);
  if (!slot) return;
  if (isSlotExpiredByEndDay(slot)) {
    const label =
      slot.startDay && slot.endDay
        ? `${slot.startDay}–${slot.endDay}`
        : "selected window";
    const err = new Error(
      `Delivery window ${label} has expired. Use today's active slot; roll lagwad first.`
    );
    err.statusCode = 400;
    throw err;
  }
}

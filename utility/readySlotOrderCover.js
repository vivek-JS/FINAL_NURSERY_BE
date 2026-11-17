import mongoose from "mongoose";
import Order from "../models/order.model.js";
import PlantSlot from "../models/slots.model.js";
import { parseLocalDate } from "../controllers/sowingSlotReadyHelpers.js";
import { updatePlantSlotCapped } from "./shrinkPlantSlotTrails.js";

/** Nearby delivery/booking days a ready-date sow can still cover. */
export const READY_ORDER_COVER_DAYS = 5;

const SLOT_FILTERS = (slotId) => [
  { "st.slots._id": slotId },
  { "sl._id": slotId },
];

export function istYmd(d) {
  if (!d) return "";
  return new Date(d).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
}

export function dayMs(input) {
  if (input == null || input === "") return NaN;
  if (input instanceof Date || (typeof input === "string" && /T|Z/.test(input) && !/^\d{2}-\d{2}-\d{4}$/.test(input))) {
    const ymd = istYmd(input);
    if (/^\d{4}-\d{2}-\d{2}$/.test(ymd)) {
      const [y, m, d] = ymd.split("-").map(Number);
      return Date.UTC(y, m - 1, d);
    }
  }
  if (typeof input === "string" && /^\d{4}-\d{2}-\d{2}$/.test(input)) {
    const [y, m, d] = input.split("-").map(Number);
    return Date.UTC(y, m - 1, d);
  }
  const parsed = parseLocalDate(input);
  if (!parsed) return NaN;
  return Date.UTC(parsed.getFullYear(), parsed.getMonth(), parsed.getDate());
}

export function coverOffsetDays(delivery, ready) {
  const a = dayMs(delivery);
  const b = dayMs(ready);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.round((a - b) / 86400000);
}

export function inReadyCoverWindow(offsetDays, windowDays = READY_ORDER_COVER_DAYS) {
  if (!Number.isFinite(offsetDays)) return false;
  const win = Math.max(0, Math.floor(Number(windowDays) || 0));
  return Math.abs(offsetDays) <= win;
}

export function shouldRebookOntoReady(bookingDay, readyDay, windowDays = READY_ORDER_COVER_DAYS) {
  const off = coverOffsetDays(bookingDay, readyDay);
  if (off == null) return false;
  if (off === 0) return false;
  return inReadyCoverWindow(off, windowDays);
}

function orderPlants(o) {
  return Math.max(0, (Number(o.numberOfPlants) || 0) + (Number(o.additionalPlants) || 0));
}

async function slotDayById(slotIds) {
  const ids = [...new Set((slotIds || []).map(String).filter((id) => mongoose.Types.ObjectId.isValid(id)))].map(
    (id) => new mongoose.Types.ObjectId(id)
  );
  const out = new Map();
  if (!ids.length) return out;
  const docs = await PlantSlot.aggregate([
    { $match: { "subtypeSlots.slots._id": { $in: ids } } },
    { $unwind: "$subtypeSlots" },
    { $unwind: "$subtypeSlots.slots" },
    { $match: { "subtypeSlots.slots._id": { $in: ids } } },
    { $project: { _id: 0, slotId: "$subtypeSlots.slots._id", startDay: "$subtypeSlots.slots.startDay" } },
  ]);
  for (const row of docs) out.set(String(row.slotId), row.startDay || "");
  return out;
}

async function incSlotBooked(slotId, delta, session = null) {
  if (!slotId || !delta) return;
  const opts = { arrayFilters: SLOT_FILTERS(slotId) };
  if (session) opts.session = session;
  await updatePlantSlotCapped(
    { "subtypeSlots.slots._id": slotId },
    { $inc: { "subtypeSlots.$[st].slots.$[sl].totalBookedPlants": delta } },
    opts
  );
}

/**
 * Move nearby-day bookings onto the sow's plant-ready slot so gap/cover
 * follow plantReadyDays, not only the exact booking calendar day.
 */
export async function rebookOrdersOntoReadySlot({
  orderIds = [],
  readySlotId,
  readyDateDmy,
  windowDays = READY_ORDER_COVER_DAYS,
} = {}) {
  if (!readySlotId || !readyDateDmy) return { moved: 0, plants: 0 };
  const ids = [...new Set((orderIds || []).map(String).filter((id) => mongoose.Types.ObjectId.isValid(id)))].map(
    (id) => new mongoose.Types.ObjectId(id)
  );
  if (!ids.length) return { moved: 0, plants: 0 };

  const orders = await Order.find({ _id: { $in: ids } })
    .select("_id numberOfPlants additionalPlants bookingSlot")
    .lean();
  const slotDays = await slotDayById(orders.map((o) => o.bookingSlot).filter(Boolean));
  const readyId = String(readySlotId);
  const toMove = [];
  for (const o of orders) {
    const fromId = o.bookingSlot ? String(o.bookingSlot) : "";
    if (!fromId || fromId === readyId) continue;
    const bookingDay = slotDays.get(fromId) || "";
    if (!shouldRebookOntoReady(bookingDay, readyDateDmy, windowDays)) continue;
    toMove.push({ orderId: o._id, fromId, plants: orderPlants(o) });
  }
  if (!toMove.length) return { moved: 0, plants: 0 };

  const fromDelta = new Map();
  let plants = 0;
  for (const row of toMove) {
    fromDelta.set(row.fromId, (fromDelta.get(row.fromId) || 0) - row.plants);
    plants += row.plants;
  }
  await Order.updateMany(
    { _id: { $in: toMove.map((r) => r.orderId) } },
    { $set: { bookingSlot: new mongoose.Types.ObjectId(readyId) } }
  );
  for (const [fromId, delta] of fromDelta) await incSlotBooked(fromId, delta);
  await incSlotBooked(readySlotId, plants);
  return { moved: toMove.length, plants };
}

/**
 * Point one order's bookingSlot at `toSlotId` and append orderEditHistory.
 * Used by sow-entry edit and by shed/app dispatch when plants leave another slot.
 * Includes DISPATCHED / COMPLETED. Adjusts slot totalBookedPlants.
 */
export async function alignOrderBookingSlotWithHistory({
  orderId,
  toSlotId,
  by = null,
  notes = "",
  session = null,
  markDispatchedFromAnotherSlot = false,
} = {}) {
  if (
    !orderId ||
    !toSlotId ||
    !mongoose.Types.ObjectId.isValid(String(orderId)) ||
    !mongoose.Types.ObjectId.isValid(String(toSlotId))
  ) {
    return { moved: false };
  }
  const toId = String(toSlotId);
  const toOid = new mongoose.Types.ObjectId(toId);
  const q = Order.findById(orderId).select(
    "_id orderStatus numberOfPlants additionalPlants bookingSlot plantLineItems.bookingSlot originalBookingSlot dispatchedFromAnotherSlot"
  );
  if (session) q.session(session);
  const o = await q.lean();
  if (!o) return { moved: false };
  const prev = o.bookingSlot ? String(o.bookingSlot) : "";
  if (prev === toId) return { moved: false, orderId: String(o._id) };

  const qty = orderPlants(o);
  const setDoc = { bookingSlot: toOid };
  if (Array.isArray(o.plantLineItems) && o.plantLineItems.length) {
    setDoc["plantLineItems.0.bookingSlot"] = toOid;
  }
  if (markDispatchedFromAnotherSlot && !o.dispatchedFromAnotherSlot) {
    setDoc.originalBookingSlot = o.originalBookingSlot || o.bookingSlot || null;
    setDoc.dispatchedFromAnotherSlot = true;
  }

  const upd = Order.updateOne(
    { _id: o._id },
    {
      $set: setDoc,
      $push: {
        orderEditHistory: {
          field: "bookingSlot",
          previousValue: o.bookingSlot || null,
          newValue: toOid,
          changedBy: by || null,
          notes:
            notes ||
            `Booking slot aligned · status ${o.orderStatus || "—"}`,
        },
      },
    }
  );
  if (session) upd.session(session);
  await upd;

  if (prev) await incSlotBooked(prev, -qty, session);
  await incSlotBooked(toId, qty, session);
  return { moved: true, orderId: String(o._id), plants: qty, fromSlotId: prev, toSlotId: toId };
}

/**
 * After sow-entry edit moves a batch to a new ready slot: move linked orders'
 * bookingSlot (incl. DISPATCHED / COMPLETED) onto that slot and write history.
 * Does not change dispatch documents — only booking/link + slot booked counts.
 */
export async function moveLinkedOrdersBookingSlotOnSowEdit({
  orderIds = [],
  sowingRequestId = null,
  fromSlotId = null,
  toSlotId = null,
  fromReadyDate = "",
  toReadyDate = "",
  by = null,
  requestNumber = "",
} = {}) {
  if (!toSlotId || !mongoose.Types.ObjectId.isValid(String(toSlotId))) {
    return { moved: 0, plants: 0, orderIds: [] };
  }

  const idSet = new Set(
    (orderIds || [])
      .map(String)
      .filter((id) => mongoose.Types.ObjectId.isValid(id))
  );
  if (sowingRequestId && mongoose.Types.ObjectId.isValid(String(sowingRequestId))) {
    const byReq = await Order.find({
      sowingDoneRequestId: new mongoose.Types.ObjectId(String(sowingRequestId)),
    })
      .select("_id")
      .lean();
    for (const o of byReq) idSet.add(String(o._id));
  }
  if (!idSet.size) return { moved: 0, plants: 0, orderIds: [] };

  const notesBase = requestNumber
    ? `Sow entry edit ${requestNumber}`
    : "Sow entry edit";
  const notes = `${notesBase}: booking slot moved with ready date${
    fromReadyDate || toReadyDate
      ? ` (${fromReadyDate || "—"} → ${toReadyDate || "—"})`
      : ""
  }`;

  let plants = 0;
  const movedIds = [];
  for (const oid of idSet) {
    const r = await alignOrderBookingSlotWithHistory({
      orderId: oid,
      toSlotId,
      by,
      notes,
    });
    if (r.moved) {
      movedIds.push(r.orderId);
      plants += r.plants || 0;
    }
  }

  void fromSlotId;
  return { moved: movedIds.length, plants, orderIds: movedIds };
}

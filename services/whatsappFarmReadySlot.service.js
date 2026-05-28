/**
 * Farm-ready WhatsApp: list next booking slots and transfer order between slots.
 */

import moment from "moment";
import mongoose from "mongoose";
import PlantSlot from "../models/slots.model.js";
import Order from "../models/order.model.js";
import { getSlotWindowById } from "../utility/findDeliverySlot.js";
import { computeAvailablePlants } from "../utility/slotAvailabilityOverview.js";

const IST_OFFSET = "+05:30";

/** @param {{ startDay: string, endDay: string, month?: string }} slot */
export function formatSlotOfferLabel(slot) {
  if (!slot?.startDay || !slot?.endDay) return "—";
  const start = moment(slot.startDay, "DD-MM-YYYY").utcOffset(IST_OFFSET);
  const end = moment(slot.endDay, "DD-MM-YYYY").utcOffset(IST_OFFSET);
  if (!start.isValid() || !end.isValid()) return `${slot.startDay}–${slot.endDay}`;

  const monthLabel = slot.month || end.format("MMMM");
  if (start.month() === end.month()) {
    return `${start.date()} to ${end.date()} ${monthLabel}`;
  }
  return `${start.date()} ${start.format("MMM")} to ${end.date()} ${end.format("MMM")}`;
}

/** Delivery date stored on order = slot window start (IST). */
export function deliveryDateFromSlotStart(slot) {
  const m = moment(slot.startDay, "DD-MM-YYYY").utcOffset(IST_OFFSET).startOf("day");
  return m.isValid() ? m.toDate() : null;
}

function slotStartMoment(slot) {
  return moment(slot.startDay, "DD-MM-YYYY").utcOffset(IST_OFFSET).startOf("day");
}

function orderPlantCount(order) {
  return (Number(order.numberOfPlants) || 0) + (Number(order.additionalPlants) || 0);
}

async function findSlotDetails(slotId) {
  if (!slotId || !mongoose.Types.ObjectId.isValid(String(slotId))) return null;
  const slotObjectId = new mongoose.Types.ObjectId(String(slotId));
  const plantSlotDoc = await PlantSlot.findOne({
    "subtypeSlots.slots._id": slotObjectId,
  }).lean();
  if (!plantSlotDoc) return null;

  for (const subtype of plantSlotDoc.subtypeSlots || []) {
    const slot = (subtype.slots || []).find(
      (item) => item._id?.toString() === slotObjectId.toString()
    );
    if (slot) {
      return {
        plantSlotId: plantSlotDoc._id,
        plantId: plantSlotDoc.plantId,
        plantSlotYear: plantSlotDoc.year,
        subtypeId: subtype.subtypeId,
        slot,
      };
    }
  }
  return null;
}

async function getSlotBookedPlantCount(slotId) {
  const orders = await Order.find({
    bookingSlot: new mongoose.Types.ObjectId(String(slotId)),
    orderStatus: { $nin: ["CANCELLED", "REJECTED", "TEMPORARY_CANCELLED"] },
    $or: [{ quotaSource: { $ne: "dealer" } }, { quotaSource: { $exists: false } }],
  })
    .select("numberOfPlants additionalPlants")
    .lean();

  return orders.reduce(
    (sum, o) => sum + (Number(o.numberOfPlants) || 0) + (Number(o.additionalPlants) || 0),
    0
  );
}

function slotHasCapacityForOrder(slot, bookedPlants, orderPlants) {
  const available = computeAvailablePlants(slot, bookedPlants);
  return available >= orderPlants;
}

/**
 * Next `limit` slot windows after current booking slot / delivery date (same plant + subtype).
 * @returns {Promise<Array<{ slotId: string, label: string, startDay: string, endDay: string, month: string, year: number, deliveryDate: Date, availablePlants: number }>>}
 */
export async function findNextSlotOptionsForOrder(order, limit = 5) {
  const plantId = order.plantName?._id || order.plantName;
  const subtypeId = order.plantSubtype?._id || order.plantSubtype;
  if (!plantId || !subtypeId) return [];

  const orderPlants = orderPlantCount(order);
  if (orderPlants <= 0) return [];

  let anchor = moment().utcOffset(IST_OFFSET).startOf("day");
  if (order.bookingSlot) {
    const currentWindow = await getSlotWindowById(order.bookingSlot);
    if (currentWindow?.endDay) {
      anchor = moment(currentWindow.endDay, "DD-MM-YYYY").utcOffset(IST_OFFSET).startOf("day");
    }
  } else if (order.deliveryDate) {
    anchor = moment(order.deliveryDate).utcOffset(IST_OFFSET).startOf("day");
  }

  const years = [anchor.year(), anchor.year() + 1];
  const plantSlots = await PlantSlot.find({
    plantId,
    year: { $in: years },
    "subtypeSlots.subtypeId": subtypeId,
  }).lean();

  const candidates = [];
  const currentSlotId = order.bookingSlot?.toString?.() || String(order.bookingSlot || "");

  for (const doc of plantSlots) {
    const subtypeSlot = (doc.subtypeSlots || []).find(
      (ss) => ss.subtypeId?.toString() === String(subtypeId)
    );
    if (!subtypeSlot) continue;

    for (const slot of subtypeSlot.slots || []) {
      if (slot.status === false) continue;
      const slotId = slot._id?.toString();
      if (!slotId || slotId === currentSlotId) continue;

      const startM = slotStartMoment(slot);
      if (!startM.isValid() || !startM.isAfter(anchor, "day")) continue;

      const booked = await getSlotBookedPlantCount(slotId);
      if (!slotHasCapacityForOrder(slot, booked, orderPlants)) continue;

      candidates.push({
        slotId,
        label: formatSlotOfferLabel(slot),
        startDay: slot.startDay,
        endDay: slot.endDay,
        month: slot.month || startM.format("MMMM"),
        year: doc.year,
        deliveryDate: deliveryDateFromSlotStart(slot),
        availablePlants: computeAvailablePlants(slot, booked),
        _sort: startM.valueOf(),
      });
    }
  }

  candidates.sort((a, b) => a._sort - b._sort);
  return candidates.slice(0, limit).map(({ _sort, ...rest }) => rest);
}

/**
 * @param {string} text
 * @param {Array<{ label: string, slotId: string }>} offeredSlots
 * @returns {number|null} 0-based index
 */
export function parseSlotChoiceFromReply(text, offeredSlots) {
  const t = String(text ?? "").trim().replace(/\s+/g, " ");
  const num = parseInt(t.replace(/[^\d]/g, ""), 10);
  if (Number.isFinite(num) && num >= 1 && num <= offeredSlots.length) {
    return num - 1;
  }
  for (let i = 0; i < offeredSlots.length; i++) {
    const label = offeredSlots[i].label || "";
    if (label && (t === label || t.includes(label))) return i;
  }
  return null;
}

/**
 * Move order to target slot + update deliveryDate (farmer WhatsApp reschedule).
 */
export async function applyFarmerSlotReschedule(order, targetSlotMeta, whatsappMessageId = "") {
  const sourceSlotId = order.bookingSlot;
  const targetSlotId = targetSlotMeta?.slotId;
  if (!sourceSlotId || !targetSlotId) {
    throw new Error("Order or target slot missing for reschedule");
  }
  if (String(sourceSlotId) === String(targetSlotId)) {
    throw new Error("Target slot is same as current slot");
  }

  const [sourceDetails, targetDetails] = await Promise.all([
    findSlotDetails(sourceSlotId),
    findSlotDetails(targetSlotId),
  ]);
  if (!sourceDetails || !targetDetails) {
    throw new Error("Source or target slot not found");
  }
  if (sourceDetails.plantId.toString() !== targetDetails.plantId.toString()) {
    throw new Error("Slot plant mismatch");
  }
  if (sourceDetails.subtypeId.toString() !== targetDetails.subtypeId.toString()) {
    throw new Error("Slot subtype mismatch");
  }

  const orderPlants = orderPlantCount(order);
  if (orderPlants <= 0) throw new Error("Order has zero plants");

  const targetBooked = await getSlotBookedPlantCount(targetSlotId);
  if (!slotHasCapacityForOrder(targetDetails.slot, targetBooked, orderPlants)) {
    throw new Error("Selected slot no longer has enough availability");
  }

  const previousDelivery = order.deliveryDate ? new Date(order.deliveryDate) : null;
  const newDeliveryDate =
    targetSlotMeta.deliveryDate || deliveryDateFromSlotStart(targetDetails.slot);

  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      const sourceSlotObjectId = new mongoose.Types.ObjectId(String(sourceSlotId));
      const targetSlotObjectId = new mongoose.Types.ObjectId(String(targetSlotId));

      await PlantSlot.updateOne(
        { _id: sourceDetails.plantSlotId },
        {
          $inc: {
            "subtypeSlots.$[st].slots.$[sl].totalBookedPlants": -orderPlants,
            "subtypeSlots.$[st].slots.$[sl].availablePlants": orderPlants,
          },
          $pull: { "subtypeSlots.$[st].slots.$[sl].orders": order._id },
        },
        {
          arrayFilters: [
            { "st.subtypeId": sourceDetails.subtypeId },
            { "sl._id": sourceSlotObjectId },
          ],
          session,
        }
      );

      await PlantSlot.updateOne(
        { _id: targetDetails.plantSlotId },
        {
          $inc: {
            "subtypeSlots.$[st].slots.$[sl].totalBookedPlants": orderPlants,
            "subtypeSlots.$[st].slots.$[sl].availablePlants": -orderPlants,
          },
          $addToSet: { "subtypeSlots.$[st].slots.$[sl].orders": order._id },
        },
        {
          arrayFilters: [
            { "st.subtypeId": targetDetails.subtypeId },
            { "sl._id": targetSlotObjectId },
          ],
          session,
        }
      );

      const deliveryChangeEntry = {
        previousDeliveryDate: {
          startDay: sourceDetails.slot.startDay,
          endDay: sourceDetails.slot.endDay,
          month: sourceDetails.slot.month,
          year: sourceDetails.plantSlotYear,
        },
        newDeliveryDate: {
          startDay: targetDetails.slot.startDay,
          endDay: targetDetails.slot.endDay,
          month: targetDetails.slot.month,
          year: targetDetails.plantSlotYear,
        },
        previousSlot: sourceSlotObjectId,
        newSlot: targetSlotObjectId,
        reasonForChange: "Farmer rescheduled delivery slot via WATI WhatsApp",
        changedBy: null,
      };

      await Order.updateOne(
        { _id: order._id },
        {
          $set: {
            bookingSlot: targetSlotObjectId,
            deliveryDate: newDeliveryDate,
            farmerWhatsappDeliveryReschedule: {
              rescheduledBy: "FARMER",
              rescheduledAt: new Date(),
              oldDeliveryDate: previousDelivery,
              whatsappMessageId: whatsappMessageId || null,
            },
          },
          $push: {
            deliveryChanges: deliveryChangeEntry,
            orderEditHistory: {
              field: "bookingSlot+deliveryDate",
              previousValue: {
                bookingSlot: sourceSlotObjectId,
                deliveryDate: previousDelivery,
              },
              newValue: {
                bookingSlot: targetSlotObjectId,
                deliveryDate: newDeliveryDate,
              },
              changedBy: null,
              notes: `WATI slot reschedule: ${sourceDetails.slot.startDay}–${sourceDetails.slot.endDay} → ${targetDetails.slot.startDay}–${targetDetails.slot.endDay}`,
            },
          },
        },
        { session }
      );
    });
  } finally {
    await session.endSession();
  }

  return {
    newDeliveryDate,
    slotLabel: formatSlotOfferLabel(targetDetails.slot),
  };
}

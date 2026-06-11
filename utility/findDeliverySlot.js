import PlantSlot from "../models/slots.model.js";
import {
  deliveryDateToIstMoment,
  isDateOutsideSlotWindow,
  isDeliveryDateInSlotWindow,
  slotDayEndMoment,
  slotDayStartMoment,
  slotWindowToDeliveryUtcRange,
} from "./istSlotDate.js";

export {
  isDateOutsideSlotWindow,
  isDeliveryDateInSlotWindow,
  slotWindowToDeliveryUtcRange,
};

/**
 * Find the slot subdocument whose date window contains deliveryDate (IST calendar days).
 */
export async function findDeliverySlotByDate(plantId, subtypeId, deliveryDate) {
  const deliveryMoment = deliveryDateToIstMoment(deliveryDate);
  if (!deliveryMoment?.isValid()) {
    throw new Error(`Invalid delivery date: ${deliveryDate}`);
  }

  const year = deliveryMoment.year();
  const month = deliveryMoment.format("MMMM");

  const plantSlot = await PlantSlot.findOne({
    plantId,
    year,
    "subtypeSlots.subtypeId": subtypeId,
  }).lean();

  if (!plantSlot) {
    throw new Error(
      `No slot configuration found for plant in year ${year}. Configure slots for this plant/subtype.`
    );
  }

  const subtypeSlot = plantSlot.subtypeSlots.find(
    (ss) => ss.subtypeId.toString() === subtypeId.toString()
  );

  if (!subtypeSlot) {
    throw new Error(`No slots found for subtype ${subtypeId}`);
  }

  const targetSlot = subtypeSlot.slots.find((slot) => {
    const start = slotDayStartMoment(slot.startDay);
    const end = slotDayEndMoment(slot.endDay);
    if (!start || !end) return false;
    return (
      deliveryMoment.isSameOrAfter(start, "day") &&
      deliveryMoment.isSameOrBefore(end, "day")
    );
  });

  if (!targetSlot) {
    throw new Error(
      `No suitable slot found for delivery date ${deliveryMoment.format(
        "DD-MM-YYYY"
      )} in month ${month}`
    );
  }

  return targetSlot;
}

export async function getSlotWindowById(slotId) {
  if (!slotId) return null;
  const plantSlotDoc = await PlantSlot.findOne({
    "subtypeSlots.slots._id": slotId,
  })
    .select("plantId subtypeSlots.subtypeId subtypeSlots.slots")
    .lean();

  if (!plantSlotDoc) return null;

  for (const subtype of plantSlotDoc.subtypeSlots || []) {
    const slot = (subtype.slots || []).find(
      (s) => s._id?.toString() === slotId.toString()
    );
    if (slot) {
      return {
        _id: slot._id,
        startDay: slot.startDay,
        endDay: slot.endDay,
        month: slot.month,
        plantId: plantSlotDoc.plantId,
        subtypeId: subtype.subtypeId,
      };
    }
  }
  return null;
}

/** Shape returned on each order as `bookingSlotDetails` (GET /order/getOrders slot-week drill-down). */
export async function getBookingSlotDetailsForOrderList({
  slotId,
  monthName,
  startDay,
  endDay,
}) {
  const slot = await getSlotWindowById(slotId);
  if (!slot) return null;
  if (
    slot.month !== monthName ||
    slot.startDay !== startDay ||
    slot.endDay !== endDay
  ) {
    return null;
  }
  return [
    {
      slotId: slot._id,
      startDay: slot.startDay,
      endDay: slot.endDay,
      subtypeId: slot.subtypeId,
      month: slot.month,
    },
  ];
}

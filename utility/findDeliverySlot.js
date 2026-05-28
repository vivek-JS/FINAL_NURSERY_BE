import moment from "moment";
import PlantSlot from "../models/slots.model.js";

/**
 * Find the slot subdocument whose date window contains deliveryDate.
 * Does not auto-create slots — callers get a clear error if missing.
 */
export async function findDeliverySlotByDate(plantId, subtypeId, deliveryDate) {
  let deliveryMoment;
  if (moment.isMoment(deliveryDate)) {
    deliveryMoment = moment.utc(deliveryDate.format("YYYY-MM-DD"));
  } else if (deliveryDate instanceof Date) {
    const year = deliveryDate.getUTCFullYear();
    const month = deliveryDate.getUTCMonth() + 1;
    const day = deliveryDate.getUTCDate();
    deliveryMoment = moment.utc(
      `${year}-${month.toString().padStart(2, "0")}-${day.toString().padStart(2, "0")}`
    );
  } else {
    deliveryMoment = moment.utc(deliveryDate);
  }

  if (!deliveryMoment.isValid()) {
    throw new Error(`Invalid delivery date: ${deliveryDate}`);
  }

  deliveryMoment = moment.utc(deliveryMoment.format("YYYY-MM-DD"));
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

  const deliveryDateStr = deliveryMoment.format("YYYY-MM-DD");
  const normalizedDeliveryDate = moment(deliveryDateStr + "T00:00:00");

  const targetSlot = subtypeSlot.slots.find((slot) => {
    const slotStart = slot.startDay.split("-").reverse().join("-");
    const slotEnd = slot.endDay.split("-").reverse().join("-");
    const startMoment = moment(slotStart + "T00:00:00");
    const endMoment = moment(slotEnd + "T00:00:00");
    return (
      normalizedDeliveryDate.isSameOrAfter(startMoment, "day") &&
      normalizedDeliveryDate.isSameOrBefore(endMoment, "day")
    );
  });

  if (!targetSlot) {
    throw new Error(
      `No suitable slot found for delivery date ${normalizedDeliveryDate.format(
        "DD-MM-YYYY"
      )} in month ${month}`
    );
  }

  return targetSlot;
}

/**
 * @param {Date|string|moment.Moment} date
 * @param {{ startDay: string, endDay: string }} slotWindow
 */
export function isDateOutsideSlotWindow(date, slotWindow) {
  if (!slotWindow?.startDay || !slotWindow?.endDay) {
    return true;
  }

  let targetMoment;
  if (date instanceof Date) {
    const y = date.getUTCFullYear();
    const m = date.getUTCMonth() + 1;
    const d = date.getUTCDate();
    targetMoment = moment.utc(
      `${y}-${m.toString().padStart(2, "0")}-${d.toString().padStart(2, "0")}`
    );
  } else {
    targetMoment = moment.utc(date);
  }
  targetMoment = moment.utc(targetMoment.format("YYYY-MM-DD"));

  const slotStart = slotWindow.startDay.split("-").reverse().join("-");
  const slotEnd = slotWindow.endDay.split("-").reverse().join("-");
  const startMoment = moment(slotStart + "T00:00:00");
  const endMoment = moment(slotEnd + "T00:00:00");

  return (
    targetMoment.isBefore(startMoment, "day") || targetMoment.isAfter(endMoment, "day")
  );
}

export async function getSlotWindowById(slotId) {
  if (!slotId) return null;
  const plantSlotDoc = await PlantSlot.findOne({
    "subtypeSlots.slots._id": slotId,
  })
    .select("subtypeSlots.slots")
    .lean();

  if (!plantSlotDoc) return null;

  for (const subtype of plantSlotDoc.subtypeSlots || []) {
    const slot = (subtype.slots || []).find(
      (s) => s._id?.toString() === slotId.toString()
    );
    if (slot) {
      return { _id: slot._id, startDay: slot.startDay, endDay: slot.endDay };
    }
  }
  return null;
}

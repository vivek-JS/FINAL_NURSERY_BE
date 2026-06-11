import moment from "moment";

/** India Standard Time — slot windows and farmer delivery dates. */
export const IST_OFFSET = "+05:30";

/** IST start-of-day for a slot calendar day (DD-MM-YYYY). */
export function slotDayStartMoment(ddMmYyyy) {
  if (!ddMmYyyy) return null;
  const m = moment(ddMmYyyy, "DD-MM-YYYY").utcOffset(IST_OFFSET, true);
  return m.isValid() ? m.startOf("day") : null;
}

/** IST end-of-day for a slot calendar day (DD-MM-YYYY). */
export function slotDayEndMoment(ddMmYyyy) {
  const m = slotDayStartMoment(ddMmYyyy);
  return m ? m.clone().endOf("day") : null;
}

/**
 * IST calendar day for a stored delivery Date / ISO string.
 * e.g. 2026-06-10T18:30:00.000Z → 11 Jun 2026 00:00 IST
 */
export function deliveryDateToIstMoment(date) {
  if (date == null || date === "") return null;
  if (moment.isMoment(date)) {
    const m = date.clone().utcOffset(IST_OFFSET);
    return m.isValid() ? m.startOf("day") : null;
  }
  const m = moment(date).utcOffset(IST_OFFSET);
  if (!m.isValid()) return null;
  return m.startOf("day");
}

export function isDateOutsideSlotWindow(date, slotWindow) {
  if (!slotWindow?.startDay || !slotWindow?.endDay) return true;
  const delivery = deliveryDateToIstMoment(date);
  const start = slotDayStartMoment(slotWindow.startDay);
  const end = slotDayEndMoment(slotWindow.endDay);
  if (!delivery || !start || !end) return true;
  return delivery.isBefore(start, "day") || delivery.isAfter(end, "day");
}

export function isDeliveryDateInSlotWindow(date, slotWindow) {
  if (!date || !slotWindow?.startDay || !slotWindow?.endDay) return false;
  return !isDateOutsideSlotWindow(date, slotWindow);
}

/** UTC bounds for MongoDB deliveryDate $gte/$lte (IST slot calendar days). */
export function slotWindowToDeliveryUtcRange(slotWindow) {
  if (!slotWindow?.startDay || !slotWindow?.endDay) return null;
  const start = slotDayStartMoment(slotWindow.startDay);
  const end = slotDayEndMoment(slotWindow.endDay);
  if (!start || !end) return null;
  return { start: start.utc().toDate(), end: end.utc().toDate() };
}

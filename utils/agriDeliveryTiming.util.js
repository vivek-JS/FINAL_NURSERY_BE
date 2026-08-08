/** Ram Agri order send/dispatch timing: today / tomorrow / custom date. */

export const AGRI_DELIVERY_TIMING = {
  TODAY: "today",
  TOMORROW: "tomorrow",
  CUSTOM: "custom",
};

export function startOfLocalDay(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

export function addLocalDays(d, days) {
  const x = startOfLocalDay(d);
  x.setDate(x.getDate() + days);
  return x;
}

export function minAgriSendDate(orderDate = new Date()) {
  const today = startOfLocalDay(new Date());
  const orderDay = startOfLocalDay(orderDate);
  return orderDay.getTime() > today.getTime() ? orderDay : today;
}

export function resolveAgriDeliveryDate(timing, customDate, orderDate = new Date()) {
  const minDay = minAgriSendDate(orderDate);
  const calendarToday = startOfLocalDay(new Date());
  const calendarTomorrow = addLocalDays(calendarToday, 1);

  if (timing === AGRI_DELIVERY_TIMING.TODAY) {
    return calendarToday.getTime() >= minDay.getTime() ? calendarToday : minDay;
  }
  if (timing === AGRI_DELIVERY_TIMING.TOMORROW) {
    return calendarTomorrow.getTime() >= minDay.getTime() ? calendarTomorrow : addLocalDays(minDay, 1);
  }
  if (timing === AGRI_DELIVERY_TIMING.CUSTOM) {
    if (customDate) {
      const picked = startOfLocalDay(customDate);
      return picked.getTime() >= minDay.getTime() ? picked : minDay;
    }
    const defaultCustom = addLocalDays(minDay, 1);
    return defaultCustom.getTime() > calendarTomorrow.getTime() ? defaultCustom : addLocalDays(calendarTomorrow, 1);
  }
  return null;
}

export function inferAgriDeliveryTiming(deliveryDate, orderDate = new Date()) {
  if (!deliveryDate) return AGRI_DELIVERY_TIMING.TODAY;
  const d = startOfLocalDay(deliveryDate);
  const today = startOfLocalDay(new Date());
  const tomorrow = addLocalDays(today, 1);
  const minDay = minAgriSendDate(orderDate);
  const effectiveToday = today.getTime() >= minDay.getTime() ? today : minDay;
  const effectiveTomorrow =
    tomorrow.getTime() >= minDay.getTime() ? tomorrow : addLocalDays(minDay, 1);
  if (d.getTime() === effectiveToday.getTime()) return AGRI_DELIVERY_TIMING.TODAY;
  if (d.getTime() === effectiveTomorrow.getTime()) return AGRI_DELIVERY_TIMING.TOMORROW;
  return AGRI_DELIVERY_TIMING.CUSTOM;
}

export function formatAgriDeliveryTimingLabel(timing, deliveryDate) {
  const dateStr = deliveryDate ? startOfLocalDay(deliveryDate).toLocaleDateString("en-IN") : "";
  if (timing === AGRI_DELIVERY_TIMING.TODAY) return dateStr ? `आज · ${dateStr}` : "आज";
  if (timing === AGRI_DELIVERY_TIMING.TOMORROW) return dateStr ? `उद्या · ${dateStr}` : "उद्या";
  if (deliveryDate) return dateStr;
  return "तारीख निवडा";
}

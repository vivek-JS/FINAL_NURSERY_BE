/** Ram Agri order delivery preference: today / tomorrow / custom date. */

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

export function resolveAgriDeliveryDate(timing, customDate, orderDate = new Date()) {
  const base = startOfLocalDay(orderDate);
  if (timing === AGRI_DELIVERY_TIMING.TODAY) return base;
  if (timing === AGRI_DELIVERY_TIMING.TOMORROW) return addLocalDays(base, 1);
  if (customDate) return startOfLocalDay(customDate);
  return null;
}

export function inferAgriDeliveryTiming(deliveryDate, orderDate = new Date()) {
  if (!deliveryDate) return AGRI_DELIVERY_TIMING.TODAY;
  const d = startOfLocalDay(deliveryDate);
  const today = startOfLocalDay(orderDate);
  const tomorrow = addLocalDays(today, 1);
  if (d.getTime() === today.getTime()) return AGRI_DELIVERY_TIMING.TODAY;
  if (d.getTime() === tomorrow.getTime()) return AGRI_DELIVERY_TIMING.TOMORROW;
  return AGRI_DELIVERY_TIMING.CUSTOM;
}

export function formatAgriDeliveryTimingLabel(timing, deliveryDate) {
  if (timing === AGRI_DELIVERY_TIMING.TODAY) return "आज";
  if (timing === AGRI_DELIVERY_TIMING.TOMORROW) return "उद्या";
  if (deliveryDate) {
    return startOfLocalDay(deliveryDate).toLocaleDateString("en-IN");
  }
  return "तारीख निवडा";
}

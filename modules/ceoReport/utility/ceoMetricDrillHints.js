/** Build drill query hints for CEO dashboard cells — FE passes verbatim to /ceo-report/orders */

export function drillForBucket(bucket, { date, month, pastDueOnly, futureDeliveryOnly, changeDirection } = {}) {
  const drill = { bucket };
  if (date) drill.date = date;
  if (month) drill.month = month;
  if (pastDueOnly) drill.pastDueOnly = "true";
  if (futureDeliveryOnly) drill.futureDeliveryOnly = "true";
  if (changeDirection) drill.changeDirection = changeDirection;
  return drill;
}

export function buildPeriodDrillMap(periodKey, { isSynthetic, isPastDue, isFuture } = {}) {
  if (isPastDue) {
    return {
      booked: drillForBucket("booking", { pastDueOnly: true }),
      dueInRange: drillForBucket("deliveryTotal", { pastDueOnly: true }),
      dispatched: drillForBucket("dispatched", { pastDueOnly: true }),
      completed: drillForBucket("completed", { pastDueOnly: true }),
      yetToDispatch: drillForBucket("yetToDispatch", { pastDueOnly: true }),
    };
  }
  if (isFuture) {
    return {
      dueInRange: drillForBucket("deliveryTotal", { futureDeliveryOnly: true }),
      yetToDispatch: drillForBucket("yetToDispatch", { futureDeliveryOnly: true }),
    };
  }

  const isMonth = /^\d{4}-\d{2}$/.test(periodKey);
  const dateArg = isMonth ? {} : { date: periodKey };
  const monthArg = isMonth ? { month: periodKey } : {};

  return {
    booked: drillForBucket("booking", { ...dateArg, ...monthArg }),
    dueInRange: drillForBucket("deliveryTotal", { ...dateArg, ...monthArg }),
    dispatched: drillForBucket("dispatched", { ...dateArg, ...monthArg }),
    completed: drillForBucket("completed", { ...dateArg, ...monthArg }),
    yetToDispatch: drillForBucket("yetToDispatch", { ...dateArg, ...monthArg }),
    deliveryChanged: drillForBucket("deliveryChanged", { ...dateArg, ...monthArg }),
    earlyDelivery: drillForBucket("earlyDelivery", { ...dateArg, ...monthArg }),
  };
}

export function buildSummaryFromMis(misData, dueSummary, futureSummary) {
  const totals = misData?.totals || {};
  const booking = totals.booking || { orders: 0, plants: 0 };
  const delivery = totals.delivery || {};

  const sumYetToDispatch = () => {
    const keys = [
      "accepted",
      "farmReady",
      "readyForDispatch",
      "dispatchProcess",
      "partiallyCompleted",
      "other",
    ];
    return keys.reduce(
      (acc, k) => {
        const b = delivery[k] || { orders: 0, plants: 0 };
        return {
          orders: acc.orders + (b.orders || 0),
          plants: acc.plants + (b.plants || 0),
        };
      },
      { orders: 0, plants: 0 }
    );
  };

  return {
    booked: { ...booking },
    dueInRange: dueSummary?.inRange
      ? { ...dueSummary.inRange }
      : { ...(delivery.total || { orders: 0, plants: 0 }) },
    out: { ...(delivery.dispatched || { orders: 0, plants: 0 }) },
    completed: { ...(delivery.completed || { orders: 0, plants: 0 }) },
    yetToDispatch: sumYetToDispatch(),
    pastDue: dueSummary?.pastDue
      ? { ...dueSummary.pastDue }
      : { orders: 0, plants: 0 },
    futureDelivery: futureSummary
      ? { orders: futureSummary.orders, plants: futureSummary.plants }
      : { orders: 0, plants: 0 },
    deliveryChanged: { orders: 0, farmers: 0 },
    earlyDelivery: { orders: 0, farmers: 0 },
  };
}

export function compactPeriodRow(day, depth) {
  const booking = day.booking || { orders: 0, plants: 0 };
  const d = day.delivery || {};
  const row = {
    key: day.date,
    label: day.label || day.date,
    isSynthetic: Boolean(day.isPastDue || day.isFuture),
    isPastDue: Boolean(day.isPastDue),
    isFuture: Boolean(day.isFuture),
    booking,
    metrics: {
      dueInRange: d.total || { orders: 0, plants: 0 },
      out: d.dispatched || { orders: 0, plants: 0 },
      completed: d.completed || { orders: 0, plants: 0 },
      yetToDispatch: sumYetToDispatchFromDelivery(d),
    },
    drill: buildPeriodDrillMap(day.date, {
      isPastDue: day.isPastDue,
      isFuture: day.isFuture,
    }),
  };

  if (depth === "full") {
    row.delivery = d;
  }
  return row;
}

function sumYetToDispatchFromDelivery(d) {
  const keys = [
    "accepted",
    "farmReady",
    "readyForDispatch",
    "dispatchProcess",
    "partiallyCompleted",
    "other",
  ];
  return keys.reduce(
    (acc, k) => {
      const b = d[k] || { orders: 0, plants: 0 };
      return {
        orders: acc.orders + (b.orders || 0),
        plants: acc.plants + (b.plants || 0),
      };
    },
    { orders: 0, plants: 0 }
  );
}

export function rollupDaysToMonths(days) {
  const map = new Map();
  for (const day of days || []) {
    if (day.isPastDue || day.isFuture || day.date === "past-due" || day.date === "future") {
      continue;
    }
    const ym = String(day.date).slice(0, 7);
    if (!map.has(ym)) {
      map.set(ym, {
        key: ym,
        label: ym,
        booking: { orders: 0, plants: 0 },
        delivery: {
          total: { orders: 0, plants: 0 },
          dispatched: { orders: 0, plants: 0 },
          completed: { orders: 0, plants: 0 },
          accepted: { orders: 0, plants: 0 },
          farmReady: { orders: 0, plants: 0 },
          readyForDispatch: { orders: 0, plants: 0 },
          dispatchProcess: { orders: 0, plants: 0 },
          partiallyCompleted: { orders: 0, plants: 0 },
          other: { orders: 0, plants: 0 },
        },
      });
    }
    const m = map.get(ym);
    m.booking.orders += day.booking?.orders || 0;
    m.booking.plants += day.booking?.plants || 0;
    for (const k of Object.keys(m.delivery)) {
      m.delivery[k].orders += day.delivery?.[k]?.orders || 0;
      m.delivery[k].plants += day.delivery?.[k]?.plants || 0;
    }
  }
  return [...map.values()].sort((a, b) => a.key.localeCompare(b.key));
}

/** @typedef {{ orders: number, plants: number }} OrderPlantsMetric */
/** @typedef {OrderPlantsMetric & { plantsRemaining?: number }} DeliveryBucketMetric */

const STATUSES_WITH_REMAINING = new Set([
  "READY_FOR_DISPATCH",
  "DISPATCH_PROCESS",
  "PARTIALLY_COMPLETED",
]);

/** Maps orderStatus → delivery bucket key on daily MIS row */
export function statusToDeliveryBucket(status) {
  switch (status) {
    case "ACCEPTED":
      return "accepted";
    case "FARM_READY":
      return "farmReady";
    case "READY_FOR_DISPATCH":
      return "readyForDispatch";
    case "DISPATCH_PROCESS":
      return "dispatchProcess";
    case "PARTIALLY_COMPLETED":
      return "partiallyCompleted";
    case "DISPATCHED":
      return "dispatched";
    case "COMPLETED":
      return "completed";
    default:
      return "other";
  }
}

export function emptyOrderPlants() {
  return { orders: 0, plants: 0 };
}

export function emptyDeliveryBucket(includeRemaining = false) {
  if (includeRemaining) {
    return { orders: 0, plants: 0, plantsRemaining: 0 };
  }
  return { orders: 0, plants: 0 };
}

export function emptyDeliveryDay() {
  return {
    total: emptyOrderPlants(),
    accepted: emptyOrderPlants(),
    farmReady: emptyOrderPlants(),
    readyForDispatch: emptyDeliveryBucket(true),
    dispatchProcess: emptyDeliveryBucket(true),
    partiallyCompleted: emptyDeliveryBucket(true),
    dispatched: emptyOrderPlants(),
    vehicleDispatched: emptyOrderPlants(),
    completed: emptyOrderPlants(),
    other: emptyOrderPlants(),
  };
}

export const DELIVERY_BUCKET_KEYS = [
  "accepted",
  "farmReady",
  "readyForDispatch",
  "dispatchProcess",
  "partiallyCompleted",
  "dispatched",
  "completed",
  "other",
];

function normalizeLabel(value, fallback) {
  if (value == null || value === "") return fallback;
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (typeof value === "object" && typeof value.name === "string" && value.name) {
    return value.name;
  }
  return fallback;
}

function varietyKey(plantName, subtype) {
  return `${normalizeLabel(plantName, "Unknown")}\u0000${normalizeLabel(subtype, "Other")}`;
}

export function recomputeDeliveryTotal(delivery) {
  const total = emptyOrderPlants();
  for (const key of DELIVERY_BUCKET_KEYS) {
    total.orders += delivery[key].orders || 0;
    total.plants += delivery[key].plants || 0;
  }
  delivery.total = total;
  return delivery;
}

/**
 * @param {Array<{ _id: { day: string, status: string }, orders: number, plants: number, plantsRemaining?: number }>} rows
 * @returns {Map<string, ReturnType<typeof emptyDeliveryDay>>}
 */
export function pivotDeliveryByDay(rows) {
  const byDay = new Map();
  for (const row of rows || []) {
    const day = row._id?.day;
    const status = row._id?.status;
    if (!day || !status) continue;
    if (!byDay.has(day)) byDay.set(day, emptyDeliveryDay());
    const delivery = byDay.get(day);
    const bucketKey = statusToDeliveryBucket(status);
    const bucket = delivery[bucketKey];
    bucket.orders += row.orders || 0;
    bucket.plants += row.plants || 0;
    if (
      STATUSES_WITH_REMAINING.has(status) &&
      typeof bucket.plantsRemaining === "number"
    ) {
      bucket.plantsRemaining += row.plantsRemaining || 0;
    }
  }
  for (const delivery of byDay.values()) {
    recomputeDeliveryTotal(delivery);
  }
  return byDay;
}

/**
 * @param {Array<{ _id: string, orders: number, plants: number }>} rows
 */
export function bookingRowsToMap(rows) {
  const map = new Map();
  for (const row of rows || []) {
    if (row._id) {
      map.set(row._id, {
        orders: row.orders || 0,
        plants: row.plants || 0,
      });
    }
  }
  return map;
}

/**
 * @param {Array<{ _id: string, uniqueOrders: number }>} rows
 */
export function uniqueRowsToMap(rows) {
  const map = new Map();
  for (const row of rows || []) {
    if (row._id) map.set(row._id, row.uniqueOrders || 0);
  }
  return map;
}

export function addOrderPlants(a, b) {
  return {
    orders: (a?.orders || 0) + (b?.orders || 0),
    plants: (a?.plants || 0) + (b?.plants || 0),
  };
}

export function addDeliveryDays(a, b) {
  const out = emptyDeliveryDay();
  for (const key of DELIVERY_BUCKET_KEYS) {
    const srcA = a[key];
    const srcB = b[key];
    if (
      key === "readyForDispatch" ||
      key === "dispatchProcess" ||
      key === "partiallyCompleted"
    ) {
      out[key] = {
        orders: (srcA?.orders || 0) + (srcB?.orders || 0),
        plants: (srcA?.plants || 0) + (srcB?.plants || 0),
        plantsRemaining:
          (srcA?.plantsRemaining || 0) + (srcB?.plantsRemaining || 0),
      };
    } else {
      out[key] = addOrderPlants(srcA, srcB);
    }
  }
  recomputeDeliveryTotal(out);
  return out;
}

/**
 * Build daily MIS rows + footer totals.
 */
export function buildAdminDailyMisPayload({
  dateKeys,
  bookingRows = [],
  deliveryRows = [],
  uniquePerDayRows = [],
  rangeUniqueOrders = 0,
}) {
  const bookingMap = bookingRowsToMap(bookingRows);
  const deliveryMap = pivotDeliveryByDay(deliveryRows);
  const uniqueMap = uniqueRowsToMap(uniquePerDayRows);

  const days = dateKeys.map((date) => ({
    date,
    booking: bookingMap.get(date) || emptyOrderPlants(),
    delivery: deliveryMap.get(date) || emptyDeliveryDay(),
    uniqueOrders: uniqueMap.get(date) || 0,
  }));

  const totals = {
    booking: emptyOrderPlants(),
    delivery: emptyDeliveryDay(),
    uniqueOrders: rangeUniqueOrders,
  };

  for (const day of days) {
    totals.booking = addOrderPlants(totals.booking, day.booking);
    totals.delivery = addDeliveryDays(totals.delivery, day.delivery);
  }

  return {
    timezone: "Asia/Kolkata",
    days,
    totals,
  };
}

/**
 * @param {Array<{ _id: { plantName: string, subtype: string, status: string }, orders: number, plants: number, plantsRemaining?: number }>} rows
 */
export function pivotVarietyDelivery(rows) {
  const byKey = new Map();
  for (const row of rows || []) {
    const plantName = row._id?.plantName || "Unknown";
    const subtype = row._id?.subtype || "Other";
    const status = row._id?.status;
    if (!status) continue;
    const key = varietyKey(plantName, subtype);
    if (!byKey.has(key)) {
      byKey.set(key, {
        plantName,
        subtype,
        plantId: row._id?.plantId,
        subtypeId: row._id?.subtypeId,
        delivery: emptyDeliveryDay(),
      });
    }
    const entry = byKey.get(key);
    const bucketKey = statusToDeliveryBucket(status);
    const bucket = entry.delivery[bucketKey];
    bucket.orders += row.orders || 0;
    bucket.plants += row.plants || 0;
    if (
      STATUSES_WITH_REMAINING.has(status) &&
      typeof bucket.plantsRemaining === "number"
    ) {
      bucket.plantsRemaining += row.plantsRemaining || 0;
    }
  }
  for (const entry of byKey.values()) {
    recomputeDeliveryTotal(entry.delivery);
  }
  return byKey;
}

/**
 * @param {Array<{ plantName: string, subtype: string, bookingOrders?: number, bookingPlants?: number }>} bookingRows
 * @param {Array} deliveryRows — output of variety delivery aggregation
 */
export function buildVarietyTable(bookingRows = [], deliveryRows = []) {
  const deliveryMap = pivotVarietyDelivery(deliveryRows);
  const keys = new Set();

  for (const row of bookingRows || []) {
    keys.add(varietyKey(row.plantName, row.subtype));
  }
  for (const key of deliveryMap.keys()) {
    keys.add(key);
  }

  const rows = [];
  for (const key of keys) {
    const booking = (bookingRows || []).find(
      (r) => varietyKey(r.plantName, r.subtype) === key
    );
    const deliveryEntry = deliveryMap.get(key);
    const [plantName, subtype] = key.split("\u0000");
    rows.push({
      plantName: normalizeLabel(
        booking?.plantName || deliveryEntry?.plantName || plantName,
        "Unknown"
      ),
      subtype: normalizeLabel(
        booking?.subtype || deliveryEntry?.subtype || subtype,
        "Other"
      ),
      plantId: booking?.plantId || deliveryEntry?.plantId,
      subtypeId: booking?.subtypeId || deliveryEntry?.subtypeId,
      booking: {
        orders: booking?.bookingOrders || 0,
        plants: booking?.bookingPlants || 0,
      },
      delivery: deliveryEntry?.delivery || emptyDeliveryDay(),
    });
  }

  rows.sort((a, b) => {
    const p = a.plantName.localeCompare(b.plantName);
    if (p !== 0) return p;
    return a.subtype.localeCompare(b.subtype);
  });

  const totals = {
    booking: emptyOrderPlants(),
    delivery: emptyDeliveryDay(),
  };
  for (const row of rows) {
    totals.booking = addOrderPlants(totals.booking, row.booking);
    totals.delivery = addDeliveryDays(totals.delivery, row.delivery);
  }

  return { rows, totals };
}

function personKey(personId, personName) {
  const idPart = personId != null ? String(personId) : "none";
  return `${idPart}\u0000${normalizeLabel(personName, "Unknown")}`;
}

/**
 * @param {Array<{ _id: { personId: unknown, personName: string, status: string }, orders: number, plants: number, plantsRemaining?: number }>} rows
 */
export function pivotPersonDelivery(rows) {
  const byKey = new Map();
  for (const row of rows || []) {
    const personId = row._id?.personId;
    const personName = row._id?.personName || "Unknown";
    const status = row._id?.status;
    if (!status) continue;
    const key = personKey(personId, personName);
    if (!byKey.has(key)) {
      byKey.set(key, {
        personId,
        personName,
        phoneNumber: row._id?.phoneNumber,
        jobTitle: row._id?.jobTitle,
        delivery: emptyDeliveryDay(),
      });
    }
    const entry = byKey.get(key);
    const bucketKey = statusToDeliveryBucket(status);
    const bucket = entry.delivery[bucketKey];
    bucket.orders += row.orders || 0;
    bucket.plants += row.plants || 0;
    if (
      STATUSES_WITH_REMAINING.has(status) &&
      typeof bucket.plantsRemaining === "number"
    ) {
      bucket.plantsRemaining += row.plantsRemaining || 0;
    }
  }
  for (const entry of byKey.values()) {
    recomputeDeliveryTotal(entry.delivery);
  }
  return byKey;
}

/**
 * Range summary by person (sales rep or dealer).
 * @param {Array<{ personId: unknown, personName: string, phoneNumber?: string, jobTitle?: string, bookingOrders?: number, bookingPlants?: number }>} bookingRows
 */
export function buildPersonBreakdownTable(bookingRows = [], deliveryRows = []) {
  const deliveryMap = pivotPersonDelivery(deliveryRows);
  const keys = new Set();

  for (const row of bookingRows || []) {
    keys.add(personKey(row.personId, row.personName));
  }
  for (const key of deliveryMap.keys()) {
    keys.add(key);
  }

  const rows = [];
  for (const key of keys) {
    const booking = (bookingRows || []).find(
      (r) => personKey(r.personId, r.personName) === key
    );
    const deliveryEntry = deliveryMap.get(key);
    const [, personName] = key.split("\u0000");
    rows.push({
      personId: booking?.personId ?? deliveryEntry?.personId,
      personName: normalizeLabel(
        booking?.personName || deliveryEntry?.personName || personName,
        "Unknown"
      ),
      phoneNumber: booking?.phoneNumber || deliveryEntry?.phoneNumber,
      jobTitle: booking?.jobTitle || deliveryEntry?.jobTitle,
      booking: {
        orders: booking?.bookingOrders || 0,
        plants: booking?.bookingPlants || 0,
      },
      delivery: deliveryEntry?.delivery || emptyDeliveryDay(),
    });
  }

  rows.sort((a, b) => a.personName.localeCompare(b.personName));

  const totals = {
    booking: emptyOrderPlants(),
    delivery: emptyDeliveryDay(),
  };
  for (const row of rows) {
    totals.booking = addOrderPlants(totals.booking, row.booking);
    totals.delivery = addDeliveryDays(totals.delivery, row.delivery);
  }

  return { rows, totals };
}

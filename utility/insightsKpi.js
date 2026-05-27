/**
 * Pure KPI helpers for insights dashboard (delivery-date buckets, week schedule).
 * Used by insights.controller.js and unit tests.
 */

export const CLOSED_FOR_EXPECTED_KPI = new Set([
  "DISPATCHED",
  "DISPATCH_PROCESS",
  "COMPLETED",
  "PARTIALLY_COMPLETED",
  "CANCELLED",
  "REJECTED",
  "TEMPORARY_CANCELLED",
]);

export const KPI_DELIVERY_LOOKBACK_DAYS = 90;
export const KPI_DELIVERY_LOOKAHEAD_DAYS = 7;
export const KPI_ORDER_CAP = 15000;
export const WEEK_SCHEDULE_DAYS = 8;

/** IST calendar YYYY-MM-DD. */
export function istCalendarDateString(d = new Date()) {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = fmt.formatToParts(d);
  const y = parts.find((p) => p.type === "year")?.value;
  const m = parts.find((p) => p.type === "month")?.value;
  const day = parts.find((p) => p.type === "day")?.value;
  return `${y}-${m}-${day}`;
}

export function istYmdFromValue(value) {
  if (value == null || value === "") return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return istCalendarDateString(d);
}

export function istAddDaysYmd(ymd, days) {
  const pivot = new Date(`${ymd}T12:00:00+05:30`);
  pivot.setDate(pivot.getDate() + days);
  return istCalendarDateString(pivot);
}

export function plantsForKpiOrder(row) {
  const rem = Number(row.remainingPlants);
  if (Number.isFinite(rem) && rem >= 0) return rem;
  return Number(row.qty) || 0;
}

export function isOpenForExpectedKpi(row, excludeReadyForDispatch) {
  const st = String(row.rawOrderStatus || row.orderStatus || "").toUpperCase();
  if (CLOSED_FOR_EXPECTED_KPI.has(st)) return false;
  if (excludeReadyForDispatch && st === "READY_FOR_DISPATCH") return false;
  return true;
}

export function isReadyForDispatchActual(row) {
  const st = String(row.rawOrderStatus || row.orderStatus || "").toUpperCase();
  return st === "READY_FOR_DISPATCH";
}

export function slimOrderForKpi(row) {
  return {
    id: row.id,
    orderId: row.orderId,
    farmerName: row.farmerName || "",
    salesperson: row.salesperson || "",
    plantId: row.plantId,
    variety: row.variety || "",
    plants: plantsForKpiOrder(row),
    deliveryDate: row.deliveryDate || null,
    orderStatus: row.rawOrderStatus || row.orderStatus || "",
    district: row.district || "",
    taluka: row.taluka || "",
    village: row.village || "",
  };
}

function emptyBucket() {
  return { plantCount: 0, orderCount: 0, orders: [] };
}

function pushToBucket(bucket, slim, plants) {
  bucket.plantCount += plants;
  bucket.orderCount += 1;
  bucket.orders.push(slim);
}

/**
 * @param {object[]} orders - Mapped insight order rows (deliveryDate, rawOrderStatus, etc.)
 * @param {object[]} dispatches - Dispatch rows with date, orderIds optional on raw dispatch docs
 * @param {string} reportDateStr - IST YYYY-MM-DD
 * @param {object} options
 * @param {boolean} [options.excludeReadyForDispatch]
 * @param {Map<string, object>} [options.orderByMongoId] - Mongo _id string → order row (for todayActual)
 * @param {object[]} [options.dispatchDocs] - Raw dispatch docs with orderIds (Mongo ObjectIds)
 */
export function computeDispatchKpiSummary(
  orders,
  dispatches,
  reportDateStr,
  options = {}
) {
  const excludeReadyForDispatch = Boolean(options.excludeReadyForDispatch);
  const next7EndYmd = istAddDaysYmd(reportDateStr, KPI_DELIVERY_LOOKAHEAD_DAYS);

  const todayExpected = emptyBucket();
  const next7Expected = emptyBucket();
  const due = emptyBucket();
  const todayActual = {
    plantCount: 0,
    orderCount: 0,
    dispatchCount: 0,
    dispatches: [],
    orders: [],
  };

  const weekSchedule = [];
  for (let i = 0; i < WEEK_SCHEDULE_DAYS; i++) {
    const dayYmd = istAddDaysYmd(reportDateStr, i);
    weekSchedule.push({
      date: dayYmd,
      expected: emptyBucket(),
      actualReady: emptyBucket(),
    });
  }
  const weekByDate = new Map(weekSchedule.map((d) => [d.date, d]));

  for (const o of orders) {
    const delYmd = istYmdFromValue(o.deliveryDate);
    if (!delYmd) continue;
    const plants = plantsForKpiOrder(o);
    const slim = slimOrderForKpi(o);

    if (isOpenForExpectedKpi(o, excludeReadyForDispatch)) {
      if (delYmd < reportDateStr) {
        pushToBucket(due, slim, plants);
      } else if (delYmd === reportDateStr) {
        pushToBucket(todayExpected, slim, plants);
      } else if (delYmd > reportDateStr && delYmd <= next7EndYmd) {
        pushToBucket(next7Expected, slim, plants);
      }

      const weekDay = weekByDate.get(delYmd);
      if (weekDay) {
        pushToBucket(weekDay.expected, slim, plants);
      }
    }

    if (isReadyForDispatchActual(o)) {
      const weekDay = weekByDate.get(delYmd);
      if (weekDay) {
        pushToBucket(weekDay.actualReady, slim, plants);
      }
    }
  }

  const orderById = new Map();
  for (const o of orders) {
    if (o.id) orderById.set(o.id, o);
    if (o.orderId != null) orderById.set(`ORD-${o.orderId}`, o);
    if (o.mongoId) orderById.set(String(o.mongoId), o);
  }
  const mongoMap = options.orderByMongoId || new Map();

  const seenOrderKeys = new Set();
  for (const d of dispatches) {
    const dYmd = istYmdFromValue(d.date);
    if (dYmd !== reportDateStr) continue;
    todayActual.plantCount += Number(d.totalPlants) || 0;
    todayActual.dispatchCount += 1;
    todayActual.dispatches.push({
      id: d.id,
      vehicle: d.vehicle || "",
      driver: d.driver || "",
      totalPlants: Number(d.totalPlants) || 0,
      orders: Number(d.orders) || 0,
      status: d.status || "scheduled",
    });

    const ids = d.orderIds || [];
    for (const oid of ids) {
      const key = String(oid);
      if (seenOrderKeys.has(key)) continue;
      seenOrderKeys.add(key);
      const row =
        mongoMap.get(key) ||
        orderById.get(key) ||
        null;
      if (row) {
        const slim = slimOrderForKpi(row);
        todayActual.orders.push(slim);
      }
    }
  }

  if (todayActual.orders.length > 0) {
    todayActual.orderCount = todayActual.orders.length;
    const plantsFromOrders = todayActual.orders.reduce((s, r) => s + (r.plants || 0), 0);
    if (plantsFromOrders > 0) todayActual.plantCount = plantsFromOrders;
  } else {
    todayActual.orderCount = dispatches
      .filter((d) => istYmdFromValue(d.date) === reportDateStr)
      .reduce((s, d) => s + (Number(d.orders) || 0), 0);
  }

  return {
    todayExpected,
    next7Expected,
    due,
    todayActual,
    weekSchedule,
    reportDate: reportDateStr,
  };
}

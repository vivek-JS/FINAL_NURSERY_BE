import moment from "moment";
import { IST_OFFSET, deliveryDateToIstMoment } from "./istSlotDate.js";
import { splitLagwadQtyForSlot } from "./lagwadSlotPlantsSplit.js";

export const DISPATCH_DUE_STATUSES = [
  "ACCEPTED",
  "PENDING",
  "FARM_READY",
  "READY_FOR_DISPATCH",
  "DISPATCH_PROCESS",
];
const DUE_STATUS_SET = new Set(DISPATCH_DUE_STATUSES);
export const WINDOW_DAYS = [5, 10, 15];
const YMD = "YYYY-MM-DD";

const positive = (v) => Math.max(0, Math.floor(Number(v) || 0));

export function istDay(ymd) {
  const m = moment(ymd, YMD, true);
  return m.isValid() ? m.utcOffset(IST_OFFSET, true).startOf("day") : null;
}

const MIN_WINDOW = 1;
const MAX_WINDOW = 30;

/** Board presets are 5/10/15. Can sell also accepts any length the desk types, from 1 to 30 days. */
export function parseWindowDays(value) {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n) || n < MIN_WINDOW) return 5;
  return Math.min(MAX_WINDOW, n);
}

/** Plants still to hand over: pipeline status, not dealer quota, minus anything already on a vehicle. */
export function orderDueQty(order) {
  if (!order || !DUE_STATUS_SET.has(order.orderStatus)) return 0;
  if (order.quotaSource === "dealer") return 0;
  const total = positive(order.numberOfPlants) + positive(order.additionalPlants);
  const remaining = order.remainingPlants == null ? total : positive(order.remainingPlants);
  if (!order.vehicleLoaded) return remaining;
  const loaded = positive(order.vehicleLoadedQuantity);
  return loaded > 0 ? Math.max(0, remaining - loaded) : 0;
}

/** Contiguous windows of `windowDays` covering from..to (inclusive, IST days). */
export function bucketWindows(from, to, windowDays) {
  const start = istDay(from);
  const end = istDay(to);
  if (!start || !end || end.isBefore(start)) return [];
  const windows = [];
  for (let cur = start.clone(); !cur.isAfter(end, "day"); cur.add(windowDays, "days")) {
    const last = moment.min(cur.clone().add(windowDays - 1, "days"), end);
    windows.push({
      key: cur.format(YMD),
      from: cur.format(YMD),
      to: last.format(YMD),
      dispatch: 0,
      overdueDispatch: 0,
      lagwad: 0,
      readyLagwad: 0,
      orderCount: 0,
      lineCount: 0,
      oldLagwad: 0,
      unbatchedAfter: 0,
    });
  }
  return windows;
}

/**
 * Window index for a date. Dates before the first window roll into it only when
 * `rollPast` (range starts today or earlier); later than the last window → -1.
 */
export function assignToWindow(dateValue, windows, { rollPast = false } = {}) {
  if (!windows.length) return -1;
  const day = dateValue == null ? null : deliveryDateToIstMoment(dateValue);
  if (!day) return rollPast ? 0 : -1;
  const ymd = day.format(YMD);
  if (ymd < windows[0].from) return rollPast ? 0 : -1;
  for (let i = 0; i < windows.length; i += 1) {
    if (ymd <= windows[i].to) return i;
  }
  return -1;
}

export function fillDispatch(windows, orders, { rollPast, today }) {
  for (const order of orders || []) {
    const qty = orderDueQty(order);
    if (!qty) continue;
    const i = assignToWindow(order.deliveryDate, windows, { rollPast });
    if (i < 0) continue;
    const w = windows[i];
    w.dispatch += qty;
    w.orderCount += 1;
    const ymd = deliveryDateToIstMoment(order.deliveryDate)?.format(YMD);
    if (ymd && ymd < today) w.overdueDispatch += qty;
  }
  return windows;
}

function coveredPlants(order) {
  const fromSources = (order?.sowingCoverSources || []).reduce((sum, row) => sum + positive(row?.plants), 0);
  if (fromSources > 0) return fromSources;
  return (order?.sowingPartialCover || []).reduce((sum, row) => sum + positive(row?.plants), 0);
}

/**
 * Plants still to give that have no sowing batch.
 * sowingDone covers the order. A partial cover only leaves the uncovered due plants.
 */
export function unbatchedDueQty(order) {
  const due = orderDueQty(order);
  if (!due || order?.sowingDone) return 0;
  const booked = positive(order.numberOfPlants) + positive(order.additionalPlants);
  return Math.min(due, Math.max(0, booked - coveredPlants(order)));
}

/**
 * No-batch due plants whose delivery is after the first window.
 * Dates inside that window, including its last day, are already in its dispatch.
 */
export function fillUnbatchedAfter(windows, orders) {
  if (!windows.length) return windows;
  const cut = windows[0].to;
  let extra = 0;
  for (const order of orders || []) {
    const qty = unbatchedDueQty(order);
    if (!qty) continue;
    const ymd = deliveryDateToIstMoment(order.deliveryDate)?.format(YMD);
    if (ymd && ymd > cut) extra += qty;
  }
  windows[0].unbatchedAfter = extra;
  return windows;
}

/**
 * Plants shown on the dispatch board.
 * A live notebook count is plants already in hand, so no mortality.
 * Lagwad planted after that count still drops the 10% mortality.
 * Crops with no count day keep the 10% on every line.
 */
export function lagwadBoardQty(line, liveCountAsOn) {
  const avail = Math.max(0, Math.floor(Number(line?.availableQuantity) || 0));
  if (!avail) return 0;
  const cut = typeof liveCountAsOn === "string" && /^\d{4}-\d{2}-\d{2}$/.test(liveCountAsOn) ? liveCountAsOn : null;
  const inward = line?.inwardDate ? deliveryDateToIstMoment(line.inwardDate)?.format(YMD) : null;
  if (cut && inward && inward <= cut) return avail;
  return splitLagwadQtyForSlot(avail).actualPlants;
}

/** Lagwad on the board. Mortality applies only to planting after a live count day. */
export function fillLagwad(windows, lines, { rollPast, today, liveCountAsOn = null }) {
  for (const line of lines || []) {
    const qty = lagwadBoardQty(line, liveCountAsOn);
    if (!qty) continue;
    const i = assignToWindow(line.expectedReadyDate, windows, { rollPast });
    if (i < 0) continue;
    const w = windows[i];
    w.lagwad += qty;
    w.lineCount += 1;
    const ymd = line.expectedReadyDate
      ? deliveryDateToIstMoment(line.expectedReadyDate)?.format(YMD)
      : null;
    if (!ymd || ymd <= today) w.readyLagwad += qty;
    if (ymd && ymd <= oldReadyCut(today)) w.oldLagwad += qty;
  }
  return windows;
}

/** Ready on this day or earlier is 7 days old. */
function oldReadyCut(today) {
  const day = moment(today, YMD, true);
  return day.isValid() ? day.clone().subtract(7, "days").format(YMD) : today;
}

const SUM_KEYS = ["dispatch", "overdueDispatch", "lagwad", "readyLagwad", "orderCount", "lineCount"];

const emptyTotals = () => Object.fromEntries(SUM_KEYS.map((k) => [k, 0]));

function addInto(target, w) {
  for (const k of SUM_KEYS) target[k] += w[k];
  return target;
}

/** Month totals keyed by each window's start month, plus the grand total. */
export function summarize(windows) {
  const byMonth = new Map();
  const totals = emptyTotals();
  for (const w of windows) {
    const month = w.from.slice(0, 7);
    if (!byMonth.has(month)) {
      byMonth.set(month, { month, label: moment(month, "YYYY-MM").format("MMMM YYYY"), ...emptyTotals() });
    }
    addInto(byMonth.get(month), w);
    addInto(totals, w);
  }
  return { months: [...byMonth.values()], totals };
}

/**
 * Actual stock from a physical count (docs/BANANA_ACTUAL_DISPATCH.md):
 *   current = stock on the count day + sellable lagwad after that day − actual dispatch after that day
 * Sellable lagwad is 90% of each new inward. The 10% mortality is not stock.
 * Actual dispatch = DISPATCHED / COMPLETED orders, each once, only plants that left after the count day.
 */
export const ACTUAL_DISPATCH_STATUSES = ["DISPATCHED", "COMPLETED"];
const DONE = new Set(ACTUAL_DISPATCH_STATUSES);
const UNLOAD = "SECONDARY_SHED_UNLOAD";

const n = (v) => Math.max(0, Math.floor(Number(v) || 0));
const istFmt = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" });
export const istDayKey = (v) => istFmt.format(new Date(v));

/**
 * Dated legs of one order that left at/after `after` (Date): [{ day, qty }], qty < 0 for unloads.
 * Post-cutoff dispatchHistory legs win. Without them, a status change to DISPATCHED/COMPLETED after
 * the cutoff counts the order minus what already left before it, on the change day.
 * Orders whose net is under one plant give [].
 */
export function actualDispatchLegs(order, after) {
  if (!order || !DONE.has(order.orderStatus)) return [];
  const cutoff = after.getTime();
  let before = 0;
  const legs = [];
  for (const leg of order.dispatchHistory || []) {
    if (!leg?.date) continue;
    const unload = leg.source === UNLOAD;
    const qty = n(leg.quantity);
    if (new Date(leg.date).getTime() < cutoff) {
      if (!unload) before += qty;
      continue;
    }
    if (qty < 1 && !unload) continue;
    legs.push({ day: istDayKey(leg.date), qty: unload ? -qty : qty });
  }
  if (!legs.length) {
    const change = (order.statusChanges || [])
      .filter((c) => c?.createdAt && new Date(c.createdAt).getTime() >= cutoff && DONE.has(c.newStatus))
      .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))[0];
    if (!change) return [];
    legs.push({ day: istDayKey(change.createdAt), qty: n(order.numberOfPlants) + n(order.additionalPlants) - before });
  }
  return legs.reduce((s, l) => s + l.qty, 0) < 1 ? [] : legs;
}

export function actualDispatchQty(order, after) {
  return actualDispatchLegs(order, after).reduce((s, l) => s + l.qty, 0);
}

export function currentStock({ opening, lagwadAfter, dispatchAfter }) {
  return n(opening) + n(lagwadAfter) - n(dispatchAfter);
}

/** Next calendar day for a YYYY-MM-DD key. UTC math so the day does not shift. */
function nextDay(ymd) {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}

/**
 * Day ledger from the count day: opening row, then one row per day with lagwad in / dispatch out
 * and the running balance. `lagwad` = [{ day, qty }], `dispatch` = [{ day, qty, orderId, status }].
 * `through` (YYYY-MM-DD) keeps quiet days, including today, so the list does not stop on the last movement.
 */
export function buildStockLedger({ asOn, opening, lagwad, dispatch, through }) {
  const days = new Map();
  const at = (day) => {
    if (!days.has(day)) days.set(day, { day, lagwad: 0, dispatch: 0, lagwadCount: 0, orders: [] });
    return days.get(day);
  };
  for (const l of lagwad) {
    const row = at(l.day);
    row.lagwad += l.qty;
    row.lagwadCount += 1;
  }
  for (const d of dispatch) {
    const row = at(d.day);
    row.dispatch += d.qty;
    const prev = row.orders.find((o) => o.orderId === d.orderId);
    if (prev) prev.qty += d.qty;
    else row.orders.push({ orderId: d.orderId, status: d.status, qty: d.qty });
  }
  let balance = n(opening);
  const rows = [{ day: asOn, opening: true, lagwad: 0, dispatch: 0, lagwadCount: 0, orders: [], balance }];
  const sorted = [...days.values()].sort((a, b) => a.day.localeCompare(b.day));
  const lastMove = sorted.at(-1)?.day || asOn;
  const end = through && through > lastMove ? through : lastMove;
  const byDay = new Map(sorted.map((row) => [row.day, row]));
  if (!through) {
    for (const row of sorted) {
      balance += row.lagwad - row.dispatch;
      row.orders.sort((a, b) => b.qty - a.qty);
      rows.push({ ...row, opening: false, balance });
    }
    return rows;
  }
  for (let day = nextDay(asOn); day <= end; day = nextDay(day)) {
    const row = byDay.get(day) || { day, lagwad: 0, dispatch: 0, lagwadCount: 0, orders: [] };
    balance += row.lagwad - row.dispatch;
    row.orders.sort((a, b) => b.qty - a.qty);
    rows.push({ ...row, opening: false, balance });
  }
  return rows;
}

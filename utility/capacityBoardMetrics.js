import { slotDayStartMoment } from "./istSlotDate.js";
import { canBookFromExcess } from "./capacitySheetMetrics.js";

/** How far back unsold / undispatched plants on past slots still count as overdue. */
export const OVERDUE_LOOKBACK_DAYS = 30;

/** Upcoming slot columns the board table shows after the current slot, by slot length. */
export function upcomingSlotCount(slotDays) {
  return Number(slotDays) <= 1 ? 7 : 4;
}

function num(n) {
  return Number(n) || 0;
}

export function slotLengthDays(startDay, endDay) {
  const start = slotDayStartMoment(startDay);
  const end = slotDayStartMoment(endDay);
  if (!start || !end) return 0;
  return end.diff(start, "days") + 1;
}

/** past = ended before today, current = today inside the window, upcoming = starts after today. */
export function slotTiming(startDay, endDay, today) {
  const start = slotDayStartMoment(startDay);
  const end = slotDayStartMoment(endDay);
  if (!start || !end) return null;
  if (end.isBefore(today, "day")) return "past";
  if (start.isAfter(today, "day")) return "upcoming";
  return "current";
}

/** Most common slot length for a variety. Ties go to the shorter slot. */
export function dominantSlotDays(slots) {
  const counts = new Map();
  for (const slot of slots || []) {
    const days = slotLengthDays(slot.startDay, slot.endDay);
    if (days > 0) counts.set(days, (counts.get(days) || 0) + 1);
  }
  let best = 0;
  let bestN = 0;
  for (const [days, n] of counts) {
    if (n > bestN || (n === bestN && days < best)) {
      best = days;
      bestN = n;
    }
  }
  return best;
}

/**
 * One slot window on the board.
 *   booked  plants on farmer orders delivering in the window
 *   ready   plants sowed for the window: sowed against orders + free sowed excess
 *   net     ready - booked (negative = short, positive = free to sell)
 */
export function boardSlotCell({ slotId, startDay, endDay, booked, gap, excess }) {
  const b = num(booked);
  const g = Math.min(num(gap), b);
  const e = num(excess);
  return {
    slotId: slotId ? String(slotId) : null,
    startDay,
    endDay,
    booked: b,
    ready: b - g + e,
    net: canBookFromExcess(e, g),
    gap: g,
  };
}

/**
 * Past slot carried into today: only orders still waiting to dispatch count as booked,
 * plus any free sowed excess that was never sold.
 */
export function overdueSlotCell({ slotId, startDay, endDay, pendingDispatch, gap, excess }) {
  const pending = num(pendingDispatch);
  const g = Math.min(num(gap), pending);
  const e = num(excess);
  return {
    slotId: slotId ? String(slotId) : null,
    startDay,
    endDay,
    booked: pending,
    ready: pending - g + e,
    net: canBookFromExcess(e, g),
    gap: g,
    unsold: e,
  };
}

function addCells(cells) {
  return cells.reduce(
    (acc, cell) => ({
      booked: acc.booked + num(cell.booked),
      ready: acc.ready + num(cell.ready),
      net: acc.net + num(cell.net),
      gap: acc.gap + num(cell.gap),
    }),
    { booked: 0, ready: 0, net: 0, gap: 0 }
  );
}

function hasNumbers(cell) {
  return num(cell?.booked) > 0 || num(cell?.ready) > 0 || num(cell?.net) !== 0;
}

/**
 * Board row for one variety.
 * `slots` carry { slotId, startDay, endDay, booked, gap, excess, pendingDispatch }.
 * The current cell folds in every overdue past slot so urgent work sits in one column.
 * `upcoming` keeps every future slot in the window (the ready-plants message reads further ahead);
 * `totals` cover only the columns the table shows.
 */
export function buildBoardRow({ slots, today, stock = null }) {
  const slotDays = dominantSlotDays(slots);
  const past = [];
  let current = null;
  const upcoming = [];

  const ordered = (slots || [])
    .slice()
    .sort((a, b) => slotDayStartMoment(a.startDay) - slotDayStartMoment(b.startDay));

  for (const slot of ordered) {
    const timing = slotTiming(slot.startDay, slot.endDay, today);
    if (timing === "past") past.push(overdueSlotCell(slot));
    else if (timing === "current" && !current) current = boardSlotCell(slot);
    else if (timing === "upcoming") upcoming.push(boardSlotCell(slot));
  }

  const overduePast = past.filter(hasNumbers);
  const overdue = {
    ...addCells(overduePast),
    unsold: overduePast.reduce((acc, cell) => acc + num(cell.unsold), 0),
    slotIds: overduePast.map((cell) => cell.slotId).filter(Boolean),
  };

  const own = current || { slotId: null, startDay: null, endDay: null, booked: 0, ready: 0, net: 0, gap: 0 };
  const merged = addCells([own, overdue]);
  const currentCell = {
    slotId: own.slotId,
    startDay: own.startDay,
    endDay: own.endDay,
    ...merged,
    own: { booked: own.booked, ready: own.ready, net: own.net, gap: own.gap },
    overdue,
    slotIds: [own.slotId, ...overdue.slotIds].filter(Boolean),
  };

  const totals = addCells([currentCell, ...upcoming.slice(0, upcomingSlotCount(slotDays))]);

  return {
    slotDays,
    current: currentCell,
    upcoming,
    totals,
    stock: stock || { inShed: 0, readyNow: 0, batches: [] },
  };
}

export function boardRowHasNumbers(row) {
  if (num(row?.stock?.inShed) > 0) return true;
  if (hasNumbers(row?.current)) return true;
  return (row?.upcoming || []).some(hasNumbers);
}

function varietyKey(plantId, subtypeId) {
  return `${plantId || ""}-${subtypeId || ""}`;
}

function earliest(dates) {
  const times = dates
    .filter(Boolean)
    .map((d) => new Date(d).getTime())
    .filter((t) => Number.isFinite(t));
  return times.length ? new Date(Math.min(...times)) : null;
}

/** Shed stock payload rolled up per variety: plants in shed, ready now, and batch lines. */
export function shedStockByVariety(shedPayload) {
  const map = new Map();
  for (const shed of shedPayload?.sheds || []) {
    for (const batch of shed.batches || []) {
      if (num(batch.remaining) < 1) continue;
      const key = varietyKey(batch.plantId, batch.subtypeId);
      if (!map.has(key)) {
        map.set(key, {
          plantId: batch.plantId || "",
          plantName: batch.plantName || "",
          subtypeId: batch.subtypeId || "",
          subtypeName: batch.subtypeName || "",
          inShed: 0,
          readyNow: 0,
          batches: [],
        });
      }
      const entry = map.get(key);
      entry.inShed += num(batch.remaining);
      entry.readyNow += num(batch.readyRemaining);
      const live = (batch.lines || []).filter((line) => num(line.remaining) > 0);
      const waiting = live.filter((line) => !line.ready);
      entry.batches.push({
        shed: shed.shed,
        batchNumber: batch.batchNumber,
        inShed: num(batch.remaining),
        readyNow: num(batch.readyRemaining),
        notReady: Math.max(0, num(batch.remaining) - num(batch.readyRemaining)),
        lagwadDate: earliest(live.map((line) => line.lagwadDate)),
        readyDate: earliest(live.map((line) => line.readyDate)),
        nextReadyDate: earliest(waiting.map((line) => line.readyDate)),
      });
    }
  }
  for (const entry of map.values()) {
    entry.batches.sort((a, b) => b.inShed - a.inShed);
  }
  return map;
}

export { varietyKey };

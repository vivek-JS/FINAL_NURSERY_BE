import { slotDayStartMoment } from "./istSlotDate.js";
import { canBookFromExcess } from "./capacitySheetMetrics.js";

/** How far back unsold / undispatched plants on past slots still count as overdue. */
export const OVERDUE_LOOKBACK_DAYS = 30;

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
export function boardSlotCell({ slotId, startDay, endDay, booked, gap, excess, mortality }) {
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
    mortality: num(mortality),
  };
}

/**
 * Past slot carried into today: only orders still waiting to dispatch count as booked,
 * plus any free sowed excess that was never sold.
 */
export function overdueSlotCell({ slotId, startDay, endDay, pendingDispatch, gap, excess, mortality }) {
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
    mortality: num(mortality),
  };
}

function addCells(cells) {
  return cells.reduce(
    (acc, cell) => ({
      booked: acc.booked + num(cell.booked),
      ready: acc.ready + num(cell.ready),
      net: acc.net + num(cell.net),
      gap: acc.gap + num(cell.gap),
      mortality: acc.mortality + num(cell.mortality),
    }),
    { booked: 0, ready: 0, net: 0, gap: 0, mortality: 0 }
  );
}

function hasNumbers(cell) {
  return num(cell?.booked) > 0 || num(cell?.ready) > 0 || num(cell?.net) !== 0;
}

/** Days the board table looks ahead; `upcoming` still carries the full load window. */
export const BOARD_TABLE_DAYS = 30;
export const MAX_GROUP_DAYS = BOARD_TABLE_DAYS;

export function parseGroupDays(value) {
  const days = Math.floor(Number(value) || 1);
  return Math.min(MAX_GROUP_DAYS, Math.max(1, days));
}

const ymd = (m) => m.format("YYYY-MM-DD");
const ddmmyyyy = (m) => m.format("DD-MM-YYYY");

function cellWithIds(cell) {
  return {
    key: ymd(slotDayStartMoment(cell.startDay)),
    startDay: cell.startDay,
    endDay: cell.endDay,
    booked: num(cell.booked),
    ready: num(cell.ready),
    net: num(cell.net),
    gap: num(cell.gap),
    mortality: num(cell.mortality),
    slotIds: cell.slotId ? [cell.slotId] : [],
  };
}

/**
 * Table columns for one variety: `now` (current + overdue) and only the future cells that have plants.
 * groupDays 1 keeps each slot on its own date. groupDays N buckets slots by start day into N-day groups
 * counted from today; the first group (today .. today+N-1) folds into `now`.
 */
export function boardCells({ current, upcoming, today, groupDays = 1, tableDays = BOARD_TABLE_DAYS }) {
  const group = parseGroupDays(groupDays);
  const last = today.clone().add(tableDays, "days");
  const future = (upcoming || []).filter((cell) => {
    const start = slotDayStartMoment(cell.startDay);
    return start && !start.isAfter(last, "day") && hasNumbers(cell);
  });

  if (group === 1) {
    return { now: { ...current, key: "now" }, cells: future.map(cellWithIds) };
  }

  const intoNow = [];
  const buckets = new Map();
  for (const cell of future) {
    const index = Math.floor(slotDayStartMoment(cell.startDay).diff(today, "days") / group);
    if (index <= 0) {
      intoNow.push(cell);
      continue;
    }
    const from = today.clone().add(index * group, "days");
    const key = ymd(from);
    if (!buckets.has(key)) {
      buckets.set(key, { key, startDay: ddmmyyyy(from), endDay: ddmmyyyy(from.clone().add(group - 1, "days")), list: [] });
    }
    buckets.get(key).list.push(cell);
  }

  const now = {
    ...current,
    ...addCells([current, ...intoNow]),
    key: "now",
    startDay: ddmmyyyy(today),
    endDay: ddmmyyyy(today.clone().add(group - 1, "days")),
    slotIds: [...(current.slotIds || []), ...intoNow.map((cell) => cell.slotId).filter(Boolean)],
  };
  const cells = [...buckets.values()]
    .sort((a, b) => a.key.localeCompare(b.key))
    .map((bucket) => ({
      key: bucket.key,
      startDay: bucket.startDay,
      endDay: bucket.endDay,
      ...addCells(bucket.list),
      slotIds: bucket.list.map((cell) => cell.slotId).filter(Boolean),
    }));
  return { now, cells };
}

/**
 * Board row for one variety.
 * `slots` carry { slotId, startDay, endDay, booked, gap, excess, pendingDispatch }.
 * The current cell folds in every overdue past slot so urgent work sits in one column.
 * `upcoming` keeps every future slot in the window (the ready-plants message reads further ahead);
 * `now` + `cells` are the table columns (see boardCells) and `totals` add them up.
 */
export function buildBoardRow({ slots, today, stock = null, groupDays = 1, tableDays = BOARD_TABLE_DAYS }) {
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

  const { now, cells } = boardCells({ current: currentCell, upcoming, today, groupDays, tableDays });
  const totals = addCells([now, ...cells]);

  return {
    slotDays,
    current: currentCell,
    upcoming,
    now,
    cells,
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

/** Last day this slot should have been sown: ready date minus plant-ready days. */
export function slotSowByDay(startDay, readyDays) {
  const start = slotDayStartMoment(startDay);
  if (!start) return null;
  return start.clone().subtract(Math.max(0, num(readyDays)), "days");
}

/** Uncovered bookings whose sow-by date is today or already past. */
export function dueSowItems({ slots, today, readyDays }) {
  const items = [];
  for (const slot of slots || []) {
    const gap = num(slot.gap);
    if (gap <= 0) continue;
    const sowBy = slotSowByDay(slot.startDay, readyDays);
    if (!sowBy || sowBy.isAfter(today, "day")) continue;
    items.push({
      startDay: slot.startDay,
      endDay: slot.endDay,
      sowBy: sowBy.format("DD-MM-YYYY"),
      plants: gap,
      slotIds: slot.slotId ? [String(slot.slotId)] : [],
    });
  }
  return items;
}

function rowForecastCards(row) {
  const cards = [];
  if (row?.now) cards.push(row.now);
  else if (row?.current) cards.push(row.current);
  for (const cell of row?.cells || []) cards.push(cell);
  return cards;
}

/** Totals for the 30-day board: sellable excess after mortality, unsown gap, and past-due sow dates. */
export function buildBoardSummary(rows, tableDays = BOARD_TABLE_DAYS) {
  let totalExcess = 0;
  let totalUnsown = 0;
  const dueSow = [];
  for (const row of rows || []) {
    for (const cell of rowForecastCards(row)) {
      const net = num(cell?.net);
      if (net > 0) totalExcess += net;
      totalUnsown += num(cell?.gap);
    }
    for (const item of row.dueSow || []) {
      dueSow.push({
        plantName: row.plantName,
        subtypeName: row.subtypeName,
        plantId: row.plantId,
        subtypeId: row.subtypeId,
        ...item,
      });
    }
  }
  dueSow.sort((a, b) => {
    const ka = String(a.sowBy || a.startDay || "").split("-").reverse().join("");
    const kb = String(b.sowBy || b.startDay || "").split("-").reverse().join("");
    return ka.localeCompare(kb) || String(a.subtypeName).localeCompare(String(b.subtypeName));
  });
  return {
    tableDays,
    totalExcess,
    totalUnsown,
    dueSowPlants: dueSow.reduce((sum, item) => sum + num(item.plants), 0),
    dueSow,
  };
}

export { varietyKey };

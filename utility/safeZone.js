import moment from "moment";
import { slotDayEndMoment, slotDayStartMoment } from "./istSlotDate.js";
import { displaySowingFigures, excessFieldsForBatch } from "./sowingBatchExcessStamp.js";

export const SAFE_ZONE_MAX_DAYS = 62;

const intQty = (value) => Math.max(0, Math.floor(Number(value) || 0));

/** Still to dispatch: accepted, or marked ready for dispatch. */
const TO_DISPATCH = { $in: ["ACCEPTED", "READY_FOR_DISPATCH"] };

/**
 * One till date. Yet-to-deliver orders whose current delivery is on or before that day,
 * and orders whose original delivery is on or before that day after the date was changed.
 */
export function safeZoneDeliveryMatch(till) {
  return {
    orderStatus: TO_DISPATCH,
    $or: [
      { deliveryDate: { $lte: till.end } },
      { oldDeliveryDate: { $ne: null, $lte: till.end } },
    ],
  };
}

/** A single till day. There is no From date. */
export function parseSafeZoneTill(till) {
  const end = moment(String(till || ""), "YYYY-MM-DD", true);
  if (!end.isValid()) return { error: "Pick a valid date" };
  const endAt = slotDayEndMoment(end.format("DD-MM-YYYY"));
  if (!endAt) return { error: "Pick a valid date" };
  return {
    till: end.format("YYYY-MM-DD"),
    end: endAt.clone().utc().toDate(),
  };
}

/** True when a sowing ready date is exactly the till day. Earlier sowings are left out. */
export function readyOnDay(plantReadyDate, tillYmd) {
  const parsed = moment(String(plantReadyDate || ""), ["DD-MM-YYYY", "YYYY-MM-DD"], true);
  if (!parsed.isValid() || !tillYmd) return false;
  return parsed.format("YYYY-MM-DD") === tillYmd;
}

/** Plants sowed and the mortality reserve on one sowing. Destroyed plants are already off. */
export function sowingDayFigures(batch) {
  if (!batch || batch.isIrrelevant) return { sowing: 0, mortality: 0 };
  const sowing = Math.max(0, intQty(batch.plantsSowed) - intQty(batch.destroyedPlants));
  if (sowing <= 0) return { sowing: 0, mortality: 0 };
  const pct = Number(batch.sowingBufferPct);
  const pctKnown = Number.isFinite(pct) && pct > 0;
  const figures = displaySowingFigures({
    plantsSowed: sowing,
    orderCoveredPlants: 0,
    bufferPlants: pctKnown || batch.bufferPlants == null ? null : batch.bufferPlants,
    sowingBufferPct: batch.sowingBufferPct,
    mortalityMovedToExcess: batch.mortalityMovedToExcess,
    excessMovedToMortality: batch.excessMovedToMortality,
    isIrrelevant: false,
    noMortalityReserve: Boolean(batch.noMortalityReserve),
  });
  return { sowing, mortality: intQty(figures.mortality) };
}
export function parseSafeZoneRange(from, to) {
  const start = moment(String(from || ""), "YYYY-MM-DD", true);
  const end = moment(String(to || from || ""), "YYYY-MM-DD", true);
  if (!start.isValid() || !end.isValid() || end.isBefore(start, "day")) {
    return { error: "Pick a valid date range" };
  }
  const days = end.diff(start, "days") + 1;
  if (days > SAFE_ZONE_MAX_DAYS) {
    return { error: `Date range can be at most ${SAFE_ZONE_MAX_DAYS} days` };
  }
  const startAt = slotDayStartMoment(start.format("DD-MM-YYYY"));
  const endAt = slotDayEndMoment(end.format("DD-MM-YYYY"));
  if (!startAt || !endAt) return { error: "Pick a valid date range" };
  return {
    from: start.format("YYYY-MM-DD"),
    to: end.format("YYYY-MM-DD"),
    start: startAt.clone().utc().toDate(),
    end: endAt.clone().utc().toDate(),
  };
}

/**
 * Share of a sowing batch that can be sold. Mortality is not cover.
 * A 10,000 sow with a 10% reserve is 0.9. Missing batch → 1. Irrelevant → 0.
 */
export function sellableRatio(batch) {
  if (!batch) return 1;
  if (batch.isIrrelevant) return 0;
  const sowed = Math.max(0, intQty(batch.plantsSowed) - intQty(batch.destroyedPlants));
  if (sowed <= 0) return 0;
  const pct = Number(batch.sowingBufferPct);
  const pctKnown = Number.isFinite(pct) && pct > 0;
  const figures = displaySowingFigures({
    plantsSowed: sowed,
    orderCoveredPlants: 0,
    bufferPlants: pctKnown || batch.bufferPlants == null ? null : batch.bufferPlants,
    sowingBufferPct: batch.sowingBufferPct,
    mortalityMovedToExcess: batch.mortalityMovedToExcess,
    excessMovedToMortality: batch.excessMovedToMortality,
    isIrrelevant: false,
    noMortalityReserve: Boolean(batch.noMortalityReserve),
  });
  return Math.max(0, sowed - figures.mortality) / sowed;
}

/** Plants from one cover source after the batch mortality reserve is left out. */
export function sellableCoverPlants(assigned, batch) {
  const plants = intQty(assigned);
  if (plants <= 0) return 0;
  return Math.min(plants, Math.round(plants * sellableRatio(batch)));
}

/** Expected ready plants on a sowing: sowed, minus destroyed, minus the mortality reserve. */
export function expectedReadyPlants(batch) {
  if (!batch || batch.isIrrelevant) return 0;
  const sowed = Math.max(0, intQty(batch.plantsSowed) - intQty(batch.destroyedPlants));
  if (sowed <= 0) return 0;
  return Math.round(sowed * sellableRatio(batch));
}

function ymdFromDay(value) {
  const parsed = moment(String(value || ""), ["DD-MM-YYYY", "YYYY-MM-DD"], true);
  return parsed.isValid() ? parsed.format("YYYY-MM-DD") : "";
}

/** Sowings the sheet lists: expected ready plants, ready date, sowing date, and shed. */
export function readySowingRows(batches) {
  return (batches || [])
    .map((batch) => {
      const ready = expectedReadyPlants(batch);
      if (ready < 1) return null;
      return {
        batchId: String(batch._id || batch.batchId || ""),
        plantReadyDate: ymdFromDay(batch.plantReadyDate),
        sowingDate: ymdFromDay(batch.sowingDate),
        shedName: batch.shedName || "",
        requestNumber: batch.requestNumber || "",
        ready,
      };
    })
    .filter(Boolean)
    .sort(
      (a, b) =>
        String(a.plantReadyDate).localeCompare(String(b.plantReadyDate)) ||
        String(a.sowingDate).localeCompare(String(b.sowingDate)) ||
        String(a.requestNumber).localeCompare(String(b.requestNumber))
    );
}

/** DD-MM-YYYY ready dates inside the selected range. */
export function readyDateKeys(range) {
  const start = moment(String(range?.from || ""), "YYYY-MM-DD", true);
  const end = moment(String(range?.to || range?.from || ""), "YYYY-MM-DD", true);
  if (!start.isValid() || !end.isValid()) return [];
  const keys = [];
  const cursor = start.clone();
  while (cursor.isSameOrBefore(end, "day") && keys.length <= SAFE_ZONE_MAX_DAYS) {
    keys.push(cursor.format("DD-MM-YYYY"));
    cursor.add(1, "day");
  }
  return keys;
}

/** Sellable plants and the mortality reserve on the sowing already tied to this order. */
function sourceSplit(order, batchById) {
  const reversed = Boolean(order?.sowingCoverReversedAt);
  const sources = !reversed && Array.isArray(order?.sowingCoverSources) ? order.sowingCoverSources : [];
  if (sources.length) {
    return sources.reduce(
      (acc, source) => {
        const plants = intQty(source?.plants);
        const batch = batchById?.get?.(String(source?.batchId || "")) || null;
        if (batch?.isIrrelevant) return acc;
        const sellable = sellableCoverPlants(plants, batch);
        acc.covered += sellable;
        if (batch) acc.mortality += Math.max(0, plants - sellable);
        return acc;
      },
      { covered: 0, mortality: 0 }
    );
  }
  const partial = (order?.sowingPartialCover || []).reduce((sum, row) => sum + intQty(row?.plants), 0);
  return { covered: partial, mortality: 0 };
}

/** Sowings already covering this order. Reversed cover is left out. */
export function orderCoverSowings(order, batchById) {
  if (order?.sowingCoverReversedAt) return [];
  const sources = Array.isArray(order?.sowingCoverSources) ? order.sowingCoverSources : [];
  if (sources.length) {
    return sources
      .map((source) => {
        const plants = intQty(source?.plants);
        if (plants < 1) return null;
        const batch = batchById?.get?.(String(source?.batchId || "")) || null;
        if (batch?.isIrrelevant) return null;
        return {
          batchId: String(source.batchId || ""),
          requestNumber: source.requestNumber || "",
          shedName: source.shedName || "",
          sowingDate: ymdFromDay(source.sowingDate),
          plantReadyDate: ymdFromDay(source.plantReadyDate),
          plants,
          covered: sellableCoverPlants(plants, batch),
        };
      })
      .filter(Boolean);
  }
  const partial = (order?.sowingPartialCover || []).reduce((sum, row) => sum + intQty(row?.plants), 0);
  if (partial < 1) return [];
  return [
    {
      requestNumber: "",
      shedName: "",
      sowingDate: "",
      plantReadyDate: "",
      plants: partial,
      covered: partial,
      partial: true,
    },
  ];
}

/**
 * Cover for one order.
 * total is the order size. covered is sellable sowing. mortality is the reserve left out.
 * sowingDone means the gap is zero. Otherwise the gap is plants still outside sellable sowing.
 */
export function orderSafeCover(order, batchById) {
  const booked = intQty(order?.numberOfPlants) + intQty(order?.additionalPlants);
  if (booked <= 0) return { booked: 0, total: 0, covered: 0, mortality: 0, uncovered: 0 };
  const split = sourceSplit(order, batchById);
  if (order?.sowingDone) {
    return { booked, total: booked, covered: booked, mortality: split.mortality, uncovered: 0 };
  }
  const covered = Math.min(booked, split.covered);
  return { booked, total: booked, covered, mortality: split.mortality, uncovered: booked - covered };
}

/**
 * Plants still here on one sowing entry. Same number as the sowing table Remaining:
 * expected ready minus plants already out. Old sowings contribute nothing.
 */
export function sowingEntryRemaining(doc) {
  if (!doc || doc.isIrrelevant) return 0;
  const sowed = Math.max(0, intQty(doc.plantsSowed) - intQty(doc.destroyedPlants));
  if (sowed < 1) return 0;
  const fields = excessFieldsForBatch(doc, doc.sowingBufferPct || 0);
  const moved = intQty(doc.mortalityMovedToExcess);
  const mortality = doc.noMortalityReserve ? 0 : Math.max(0, intQty(fields.bufferPlants) - moved);
  const out = intQty(doc.dispatchedPlants);
  return Math.max(0, sowed - mortality - out);
}

/** Delivery date has already gone when today is known. A missing day stays with the orders still due. */
export function deliveryHasGone(deliveryDate, today) {
  const day = String(today || "");
  const delivery = String(deliveryDate || "");
  return Boolean(day && delivery && delivery < day);
}

export function buildSafeZone(lines, today = "") {
  const byKey = new Map();
  for (const line of lines || []) {
    if (!line || intQty(line.booked) < 1) continue;
    const key = `${line.plantId}|${line.subtypeId}`;
    const row = byKey.get(key) || {
      plantId: String(line.plantId || ""),
      subtypeId: String(line.subtypeId || ""),
      plantName: line.plantName || "Plant",
      subtypeName: line.subtypeName || "",
      orders: 0,
      booked: 0,
      total: 0,
      covered: 0,
      mortality: 0,
      uncovered: 0,
      pastDue: 0,
      pastDueOrders: 0,
      notDue: 0,
      notDueOrders: 0,
      safe: true,
    };
    const plants = intQty(line.total ?? line.booked);
    const gone = deliveryHasGone(line.deliveryDate, today);
    row.orders += 1;
    row.booked += intQty(line.booked);
    row.total += plants;
    row.covered += intQty(line.covered);
    row.mortality += intQty(line.mortality);
    row.uncovered += intQty(line.uncovered);
    if (gone) {
      row.pastDue += plants;
      row.pastDueOrders += 1;
    } else {
      row.notDue += plants;
      row.notDueOrders += 1;
    }
    row.safe = row.uncovered === 0;
    byKey.set(key, row);
  }
  const varieties = [...byKey.values()].sort((a, b) => {
    if (a.safe !== b.safe) return a.safe ? 1 : -1;
    return (
      b.uncovered - a.uncovered ||
      a.plantName.localeCompare(b.plantName) ||
      a.subtypeName.localeCompare(b.subtypeName)
    );
  });
  const covered = varieties.reduce((sum, row) => sum + row.covered, 0);
  const mortality = varieties.reduce((sum, row) => sum + row.mortality, 0);
  const uncovered = varieties.reduce((sum, row) => sum + row.uncovered, 0);
  const total = varieties.reduce((sum, row) => sum + row.total, 0);
  const pastDue = varieties.reduce((sum, row) => sum + intQty(row.pastDue), 0);
  const notDue = varieties.reduce((sum, row) => sum + intQty(row.notDue), 0);
  return {
    total,
    covered,
    mortality,
    uncovered,
    pastDue,
    pastDueOrders: varieties.reduce((sum, row) => sum + intQty(row.pastDueOrders), 0),
    notDue,
    notDueOrders: varieties.reduce((sum, row) => sum + intQty(row.notDueOrders), 0),
    safe: uncovered === 0,
    unsafeVarieties: varieties.filter((row) => !row.safe).length,
    varieties,
  };
}

/** Remaining plants still on live sowings, keyed plantId|subtypeId → plants. */
export function attachSowingRemaining(board, remainingByKey, names) {
  const extras = remainingByKey instanceof Map ? remainingByKey : new Map();
  const seen = new Set();
  const varieties = (board?.varieties || []).map((row) => {
    const key = `${row.plantId}|${row.subtypeId}`;
    seen.add(key);
    return { ...row, sowingRemaining: intQty(extras.get(key)) };
  });
  for (const [key, plants] of extras) {
    const count = intQty(plants);
    if (seen.has(key) || count < 1) continue;
    const meta = names?.get?.(key) || {};
    const [plantId, subtypeId] = String(key).split("|");
    varieties.push({
      ...emptyVariety({
        plantId,
        subtypeId,
        plantName: meta.plantName || "Plant",
        subtypeName: meta.subtypeName || "",
      }),
      sowingRemaining: count,
    });
  }
  return {
    ...board,
    sowingRemaining: varieties.reduce((sum, row) => sum + intQty(row.sowingRemaining), 0),
    varieties,
  };
}

const emptyVariety = (source) => ({
  plantId: String(source?.plantId || ""),
  subtypeId: String(source?.subtypeId || ""),
  plantName: source?.plantName || "Plant",
  subtypeName: source?.subtypeName || "",
  orders: 0,
  booked: 0,
  total: 0,
  covered: 0,
  mortality: 0,
  uncovered: 0,
  safe: true,
});

/**
 * The four tiles stay on the selected dates.
 * Overdue is kept beside them, so moving From or To still changes the date totals.
 */
export function withOverdue(rangeBoard, overdueBoard) {
  const extras = new Map((overdueBoard?.varieties || []).map((row) => [`${row.plantId}|${row.subtypeId}`, row]));
  const seen = new Set();
  const varieties = (rangeBoard?.varieties || []).map((row) => {
    const key = `${row.plantId}|${row.subtypeId}`;
    seen.add(key);
    return stampOverdue(row, extras.get(key));
  });
  for (const extra of extras.values()) {
    const key = `${extra.plantId}|${extra.subtypeId}`;
    if (seen.has(key)) continue;
    varieties.push(stampOverdue(emptyVariety(extra), extra));
  }
  varieties.sort((a, b) => {
    if (a.safe !== b.safe) return a.safe ? 1 : -1;
    return (
      b.uncovered + b.overdueUncovered - (a.uncovered + a.overdueUncovered) ||
      a.plantName.localeCompare(b.plantName) ||
      a.subtypeName.localeCompare(b.subtypeName)
    );
  });
  const overdueUncovered = intQty(overdueBoard?.uncovered);
  return {
    ...rangeBoard,
    overdueTotal: intQty(overdueBoard?.total),
    overdueCovered: intQty(overdueBoard?.covered),
    overdueMortality: intQty(overdueBoard?.mortality),
    overdueUncovered,
    overdueOrders: (overdueBoard?.varieties || []).reduce((sum, row) => sum + intQty(row.orders), 0),
    safe: intQty(rangeBoard?.uncovered) === 0 && overdueUncovered === 0,
    unsafeVarieties: varieties.filter((row) => !row.safe).length,
    varieties,
  };
}

function stampOverdue(row, extra) {
  const overdueUncovered = intQty(extra?.uncovered);
  return {
    ...row,
    overdueOrders: intQty(extra?.orders),
    overdueTotal: intQty(extra?.total),
    overdueCovered: intQty(extra?.covered),
    overdueMortality: intQty(extra?.mortality),
    overdueUncovered,
    safe: intQty(row?.uncovered) === 0 && overdueUncovered === 0,
  };
}

/** Excess, sowing plants, and mortality for sowings ready on the till day only. */
export function attachExcess(board, byKey) {
  const extras = byKey instanceof Map ? byKey : new Map();
  const varieties = (board?.varieties || []).map((row) => {
    const extra = extras.get(`${row.plantId}|${row.subtypeId}`) || {};
    return {
      ...row,
      excess: intQty(extra.excess),
      sowing: intQty(extra.sowing),
      sowingMortality: intQty(extra.mortality),
    };
  });
  return {
    ...board,
    excess: varieties.reduce((sum, row) => sum + intQty(row.excess), 0),
    sowing: varieties.reduce((sum, row) => sum + intQty(row.sowing), 0),
    sowingMortality: varieties.reduce((sum, row) => sum + intQty(row.sowingMortality), 0),
    varieties,
  };
}

/** Adds expected ready plants from sowing whose ready date is in the selected range. */
export function attachExpectedReady(board, readyByKey, names) {
  const ready = readyByKey instanceof Map ? readyByKey : new Map();
  const seen = new Set();
  const varieties = (board?.varieties || []).map((row) => {
    const key = `${row.plantId}|${row.subtypeId}`;
    seen.add(key);
    return { ...row, ready: intQty(ready.get(key)) };
  });
  for (const [key, plants] of ready) {
    const count = intQty(plants);
    if (seen.has(key) || count < 1) continue;
    const meta = names?.get?.(key) || {};
    const [plantId, subtypeId] = String(key).split("|");
    varieties.push({
      ...emptyVariety({
        plantId,
        subtypeId,
        plantName: meta.plantName || "Plant",
        subtypeName: meta.subtypeName || "",
      }),
      ready: count,
    });
  }
  return {
    ...board,
    ready: varieties.reduce((sum, row) => sum + intQty(row.ready), 0),
    varieties,
  };
}

/** Every order still to dispatch, overdue dates first. */
export function safeZoneOrders(lines) {
  return (lines || [])
    .filter((line) => intQty(line?.booked) > 0)
    .map((line) => ({
      orderId: String(line.orderId || ""),
      orderNumber: line.orderNumber ?? "",
      farmerName: line.farmerName || "",
      bookingDate: line.bookingDate || "",
      deliveryDate: line.deliveryDate || "",
      originalDeliveryDate: line.originalDeliveryDate || "",
      dateChanged: Boolean(line.dateChanged),
      plantId: String(line.plantId || ""),
      subtypeId: String(line.subtypeId || ""),
      plantName: line.plantName || "Plant",
      subtypeName: line.subtypeName || "",
      booked: intQty(line.booked),
      total: intQty(line.total ?? line.booked),
      covered: intQty(line.covered),
      mortality: intQty(line.mortality),
      uncovered: intQty(line.uncovered),
      overdue: Boolean(line.overdue),
      covers: (line.covers || []).map((cover) => ({
        requestNumber: cover.requestNumber || "",
        shedName: cover.shedName || "",
        sowingDate: cover.sowingDate || "",
        plantReadyDate: cover.plantReadyDate || "",
        plants: intQty(cover.plants),
        covered: intQty(cover.covered),
        partial: Boolean(cover.partial),
      })),
    }))
    .sort(
      (a, b) =>
        String(a.deliveryDate).localeCompare(String(b.deliveryDate)) ||
        String(a.farmerName).localeCompare(String(b.farmerName)) ||
        String(a.orderNumber).localeCompare(String(b.orderNumber))
    );
}

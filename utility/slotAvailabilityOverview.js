/**
 * Slot availability row helpers for GET /slots/availability-overview.
 * Aligned with getSimpleSlots + AddOrderForm booking rules.
 */

import moment from "moment";

const MONTH_ORDER = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

export function computeAvailablePlants(slot, bookedPlants) {
  const totalPlants = Number(slot?.totalPlants) || 0;
  const booked = Number(bookedPlants) || 0;
  if (slot?.availablePlants !== undefined && slot?.availablePlants !== null) {
    return Number(slot.availablePlants);
  }
  return totalPlants - booked;
}

export function computeUtilizationPct(totalPlants, bookedPlants) {
  const cap = Number(totalPlants) || 0;
  const booked = Number(bookedPlants) || 0;
  if (cap <= 0) return booked > 0 ? 100 : 0;
  return Math.min(100, Math.round((booked / cap) * 100));
}

/**
 * @returns {"ok"|"low"|"full"|"overbooked"}
 */
export function computeSlotAvailabilityStatus({
  availablePlants,
  totalPlants,
  bookedPlants,
  sowingAllowed = false,
}) {
  const avail = Number(availablePlants) || 0;
  const cap = Number(totalPlants) || 0;
  const booked = Number(bookedPlants) || 0;

  if (avail < 0 || (cap > 0 && booked > cap && !sowingAllowed)) {
    return "overbooked";
  }
  if (sowingAllowed && avail < 0) return "overbooked";
  if (avail <= 0) return "full";

  const util = computeUtilizationPct(cap, booked);
  if (util >= 80 || (cap > 0 && avail / cap < 0.2)) return "low";
  return "ok";
}

export function buildAvailabilityOverviewRow({
  plantId,
  plantName,
  subtypeId,
  subtypeName,
  slot,
  bookedPlants,
  sowingAllowed = false,
}) {
  const totalPlants = Number(slot?.totalPlants) || 0;
  const booked = Number(bookedPlants) || 0;
  const availablePlants = computeAvailablePlants(slot, booked);
  const utilizationPct = computeUtilizationPct(totalPlants, booked);
  const status = computeSlotAvailabilityStatus({
    availablePlants,
    totalPlants,
    bookedPlants: booked,
    sowingAllowed,
  });

  return {
    plantId: String(plantId),
    plantName: plantName || "Unknown",
    subtypeId: String(subtypeId),
    subtypeName: subtypeName || "Other",
    slotId: String(slot._id),
    month: slot.month || "",
    startDay: slot.startDay || "",
    endDay: slot.endDay || "",
    totalPlants,
    bookedPlants: booked,
    availablePlants,
    utilizationPct,
    status,
    sowingAllowed: Boolean(sowingAllowed),
  };
}

export function monthSortIndex(monthName) {
  const i = MONTH_ORDER.indexOf(monthName);
  return i >= 0 ? i : 99;
}

export function sortAvailabilityRows(rows) {
  return [...rows].sort((a, b) => {
    const ma = monthSortIndex(a.month);
    const mb = monthSortIndex(b.month);
    if (ma !== mb) return ma - mb;
    const pc = String(a.plantName).localeCompare(String(b.plantName));
    if (pc !== 0) return pc;
    const sc = String(a.subtypeName).localeCompare(String(b.subtypeName));
    if (sc !== 0) return sc;
    return String(a.startDay).localeCompare(String(b.startDay));
  });
}

export function summarizeAvailabilityRows(rows) {
  let totalCapacity = 0;
  let booked = 0;
  let available = 0;
  for (const row of rows) {
    totalCapacity += row.totalPlants || 0;
    booked += row.bookedPlants || 0;
    available += row.availablePlants || 0;
  }
  return {
    totalCapacity,
    booked,
    available,
    slotCount: rows.length,
  };
}

const SLOT_END_FORMATS = ["DD-MM-YYYY", "D-M-YYYY", "DD/MM/YYYY"];

/** Today start-of-day in IST (matches stock-entry past-slot rule). */
export function availabilityTodayIST() {
  return moment().utcOffset(330).startOf("day");
}

/** Past = delivery window ended (endDay before today). */
export function isAvailabilityRowPast(row, today = availabilityTodayIST()) {
  const endStr = row?.endDay;
  if (!endStr) return false;
  const end = moment(String(endStr).trim(), SLOT_END_FORMATS, true);
  if (!end.isValid()) return false;
  return end.isBefore(today, "day");
}

/** Exclude slots whose delivery period has already ended. */
export function filterNonPastAvailabilityRows(rows, today = availabilityTodayIST()) {
  return (rows || []).filter((r) => !isAvailabilityRowPast(r, today));
}

export function filterAvailabilityRows(rows, { month, plantId, search, onlyAvailable }) {
  let out = rows;
  if (plantId) {
    out = out.filter((r) => String(r.plantId) === String(plantId));
  }
  if (month) {
    out = out.filter(
      (r) => String(r.month).toLowerCase() === String(month).toLowerCase()
    );
  }
  if (onlyAvailable === true || onlyAvailable === "true") {
    out = out.filter((r) => r.availablePlants > 0);
  }
  if (search && String(search).trim()) {
    const q = String(search).trim().toLowerCase();
    out = out.filter(
      (r) =>
        String(r.plantName).toLowerCase().includes(q) ||
        String(r.subtypeName).toLowerCase().includes(q) ||
        String(r.month).toLowerCase().includes(q)
    );
  }
  return out;
}

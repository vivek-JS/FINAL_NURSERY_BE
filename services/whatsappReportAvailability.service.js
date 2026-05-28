import moment from "moment";
import PlantCms from "../models/plantCms.model.js";
import PlantSlot from "../models/slots.model.js";
import Order from "../models/order.model.js";
import {
  buildAvailabilityOverviewRow,
  filterAvailabilityRows,
  filterNonPastAvailabilityRows,
  sortAvailabilityRows,
  summarizeAvailabilityRows,
} from "../utility/slotAvailabilityOverview.js";

export const AVAILABILITY_MONTHS = [
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

/** Active plants for wizard pick list. */
export async function fetchPlantsForAvailabilityWizard() {
  const plants = await PlantCms.find({})
    .select("_id name")
    .sort({ name: 1 })
    .lean();
  return plants.map((p) => ({
    id: String(p._id),
    name: p.name || "Unknown",
  }));
}

/**
 * Load slot availability rows (same logic as GET /slots/availability-overview).
 * @param {{ year?: number, month?: string, plantId?: string, onlyAvailable?: boolean }} filters
 */
export async function fetchAvailabilityOverviewData(filters = {}) {
  const year = Number(filters.year) || moment().utcOffset(330).year();

  const [plantDocs, slotDocs] = await Promise.all([
    PlantCms.find({}).select("_id name subtypes sowingAllowed").lean(),
    PlantSlot.find({ year }).select("plantId subtypeSlots").lean(),
  ]);

  const plantById = new Map();
  const subtypeNameByKey = new Map();
  for (const plant of plantDocs) {
    const pid = plant._id.toString();
    plantById.set(pid, {
      name: plant.name || "Unknown",
      sowingAllowed: Boolean(plant.sowingAllowed),
    });
    for (const st of plant.subtypes || []) {
      subtypeNameByKey.set(`${pid}:${st._id.toString()}`, st.name || "Other");
    }
  }

  const allSlotIds = [];
  const slotMeta = [];

  for (const doc of slotDocs) {
    const pid = doc.plantId?.toString();
    if (!pid) continue;
    const plantInfo = plantById.get(pid) || { name: "Unknown", sowingAllowed: false };

    for (const subtypeSlot of doc.subtypeSlots || []) {
      const sid = subtypeSlot.subtypeId?.toString();
      if (!sid) continue;
      const subtypeName = subtypeNameByKey.get(`${pid}:${sid}`) || "Other";

      for (const slot of subtypeSlot.slots || []) {
        if (slot.status === false) continue;
        allSlotIds.push(slot._id);
        slotMeta.push({
          plantId: pid,
          plantName: plantInfo.name,
          subtypeId: sid,
          subtypeName,
          sowingAllowed: plantInfo.sowingAllowed,
          slot,
        });
      }
    }
  }

  const bookingsMap = {};
  if (allSlotIds.length > 0) {
    const orders = await Order.find({
      bookingSlot: { $in: allSlotIds },
      orderStatus: { $nin: ["CANCELLED", "REJECTED"] },
    })
      .select("bookingSlot numberOfPlants")
      .lean();

    for (const order of orders) {
      const slotId = order.bookingSlot?.toString();
      if (!slotId) continue;
      bookingsMap[slotId] =
        (bookingsMap[slotId] || 0) + (Number(order.numberOfPlants) || 0);
    }
  }

  let rows = slotMeta.map((meta) =>
    buildAvailabilityOverviewRow({
      plantId: meta.plantId,
      plantName: meta.plantName,
      subtypeId: meta.subtypeId,
      subtypeName: meta.subtypeName,
      slot: meta.slot,
      bookedPlants: bookingsMap[meta.slot._id.toString()] || 0,
      sowingAllowed: meta.sowingAllowed,
    })
  );

  rows = sortAvailabilityRows(rows);
  rows = filterNonPastAvailabilityRows(rows);
  const summaryAll = summarizeAvailabilityRows(rows);

  rows = filterAvailabilityRows(rows, {
    month: filters.month,
    plantId: filters.plantId,
    search: filters.search,
    onlyAvailable: filters.onlyAvailable,
  });

  return {
    year,
    summary: summarizeAvailabilityRows(rows),
    summaryAll,
    rows,
  };
}

const STATUS_EMOJI = {
  ok: "🟢",
  low: "🟡",
  full: "🔴",
  overbooked: "⚠️",
};

function formatRowLine(row) {
  const icon = STATUS_EMOJI[row.status] || "•";
  return (
    `${icon} *${row.subtypeName}* — ${row.startDay}–${row.endDay}\n` +
    `   Avail: *${row.availablePlants}* / ${row.totalPlants} (booked ${row.bookedPlants})`
  );
}

/** WhatsApp text — one plant + month. */
export function formatPlantMonthAvailabilityWhatsApp({ plantName, month, year, data }) {
  const s = data.summary;
  const lines = [
    "📦 *Plant availability*",
    `*${plantName}* · *${month}* ${year}`,
    "_Source: central report (slot-availability)_",
    "",
    `Slots: *${s.slotCount}* | Capacity: *${s.totalCapacity}* | Booked: *${s.booked}* | Available: *${s.available}*`,
    "",
  ];

  if (!data.rows.length) {
    lines.push("— No active slots for this plant/month.");
    return lines.join("\n");
  }

  for (const row of data.rows) {
    lines.push(formatRowLine(row));
  }
  return lines.join("\n");
}

/** WhatsApp text — all plants for one month. */
export function formatMonthAvailabilityWhatsApp({ month, year, data }) {
  const s = data.summary;
  const lines = [
    "📅 *Month-wise availability*",
    `*${month}* ${year}`,
    "_Source: central report (slot-availability)_",
    "",
    `Total slots: *${s.slotCount}* | Available plants: *${s.available}* / ${s.totalCapacity}`,
    "",
  ];

  if (!data.rows.length) {
    lines.push("— No slots found for this month.");
    return lines.join("\n");
  }

  /** @type {Map<string, typeof data.rows>} */
  const byPlant = new Map();
  for (const row of data.rows) {
    const p = row.plantName || "Unknown";
    if (!byPlant.has(p)) byPlant.set(p, []);
    byPlant.get(p).push(row);
  }

  const plantNames = [...byPlant.keys()].sort((a, b) => a.localeCompare(b));
  for (const plant of plantNames) {
    const plantRows = byPlant.get(plant);
    const plantAvail = plantRows.reduce((n, r) => n + (r.availablePlants || 0), 0);
    const plantCap = plantRows.reduce((n, r) => n + (r.totalPlants || 0), 0);
    lines.push(`*${plant}* — avail *${plantAvail}* / ${plantCap}`);
    for (const row of plantRows.slice(0, 4)) {
      lines.push(
        `  • ${row.subtypeName}: ${row.startDay}–${row.endDay} → *${row.availablePlants}* free`
      );
    }
    if (plantRows.length > 4) {
      lines.push(`  _…+${plantRows.length - 4} more slot(s)_`);
    }
    lines.push("");
  }

  return lines.join("\n").trimEnd();
}

/** Upcoming months from current IST month (includes current). */
export function upcomingMonthsForWizard(count = 6) {
  const now = moment().utcOffset(330);
  const out = [];
  for (let i = 0; i < count; i++) {
    const m = now.clone().add(i, "month");
    out.push({
      index: i + 1,
      name: AVAILABILITY_MONTHS[m.month()],
      year: m.year(),
    });
  }
  return out;
}

export function buildMonthPromptText(months) {
  const lines = ["📅 *Pick month (IST)*", ""];
  for (const m of months) {
    lines.push(`*${m.index}* — ${m.name} ${m.year}`);
  }
  lines.push("", "Reply with a number, month name, or *cancel*.");
  return lines.join("\n");
}

export function buildPlantPromptText(plants) {
  const lines = ["🌱 *Pick plant*", ""];
  plants.forEach((p, i) => {
    lines.push(`*${i + 1}* — ${p.name}`);
  });
  lines.push("", "Reply with a number or *cancel*.");
  return lines.join("\n");
}

export function resolveMonthFromChoice(text, monthOptions) {
  const t = String(text || "").trim().toLowerCase();
  const num = parseInt(t, 10);
  if (Number.isFinite(num) && num >= 1 && num <= monthOptions.length) {
    return monthOptions[num - 1];
  }
  for (const m of monthOptions) {
    if (m.name.toLowerCase() === t || m.name.toLowerCase().startsWith(t)) {
      return m;
    }
  }
  const idx = AVAILABILITY_MONTHS.findIndex(
    (name) => name.toLowerCase() === t || name.toLowerCase().startsWith(t)
  );
  if (idx >= 0) {
    const now = moment().utcOffset(330);
    return { name: AVAILABILITY_MONTHS[idx], year: now.year() };
  }
  return null;
}

export function resolvePlantFromChoice(text, plants) {
  const t = String(text || "").trim().toLowerCase();
  const num = parseInt(t, 10);
  if (Number.isFinite(num) && num >= 1 && num <= plants.length) {
    return plants[num - 1];
  }
  const byName = plants.find((p) => p.name.toLowerCase() === t);
  if (byName) return byName;
  const partial = plants.filter((p) => p.name.toLowerCase().includes(t));
  if (partial.length === 1) return partial[0];
  return null;
}

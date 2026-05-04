import moment from "moment";
import Booking from "../models/Booking.js";
import Order from "../models/order.model.js";

/**
 * `orders` (default) = real farmer plant orders for today (IST) from `orders` + PlantCms.
 * `bookings` = legacy standalone `bookings` collection.
 */
function getBookingReportSource() {
  return (process.env.BOOKING_REPORT_SOURCE || "orders")
    .trim()
    .toLowerCase();
}

/** @type {readonly string[]} */
const REPORT_TRIGGER_PHRASES_EN = [
  "today booking",
  "todays booking",
  "today's booking",
  "booking report",
  "booking summary",
  "daily booking",
];

/** @type {readonly string[]} */
const REPORT_TRIGGER_MARATHI = [
  "आजचा बुकिंग रिपोर्ट",
  "आजची बुकिंग",
  "बुकिंग रिपोर्ट",
];

/**
 * Whether the inbound WhatsApp text should trigger today's booking PDF flow.
 * @param {string} [messageText]
 */
export function shouldGenerateTodayBookingReport(messageText) {
  if (!messageText || typeof messageText !== "string") {
    return false;
  }
  const raw = messageText.trim();
  if (REPORT_TRIGGER_MARATHI.some((phrase) => raw.includes(phrase))) {
    return true;
  }
  const lower = raw.toLowerCase();
  return REPORT_TRIGGER_PHRASES_EN.some((phrase) => lower.includes(phrase));
}

/**
 * If the user asked in Marathi, use Marathi caption on the file message (bonus).
 * @param {string} [originalMessage]
 */
export function pickReportCaption(originalMessage) {
  const raw = originalMessage || "";
  if (raw.includes("आजचा बुकिंग रिपोर्ट")) {
    return "आजचा बुकिंग रिपोर्ट तयार आहे";
  }
  if (
    raw.includes("आजची बुकिंग") ||
    raw.includes("बुकिंग रिपोर्ट")
  ) {
    return "आजचा बुकिंग रिपोर्ट तयार आहे";
  }
  return "Today Booking Report";
}

/**
 * Start/end of "today" in IST (UTC+5:30), aligned with typical India nursery operations.
 */
export function getTodayRangeIST() {
  const start = moment().utcOffset(330).startOf("day").toDate();
  const end = moment().utcOffset(330).endOf("day").toDate();
  return { start, end };
}

/**
 * IST calendar-day range (inclusive start, inclusive end-of-day end).
 * @param {Date|string|moment.Moment} startDay first day
 * @param {Date|string|moment.Moment} endDay last day
 */
export function getISTRangeInclusive(startDay, endDay) {
  const s = moment(startDay).utcOffset(330).startOf("day").toDate();
  const e = moment(endDay).utcOffset(330).endOf("day").toDate();
  if (e < s) {
    return { start: e, end: s };
  }
  return { start: s, end: e };
}

export function formatISTRangeLabel(start, end) {
  const a = moment(start).utcOffset(330).format("YYYY-MM-DD");
  const b = moment(end).utcOffset(330).format("YYYY-MM-DD");
  return a === b ? `${a} (IST)` : `${a} → ${b} (IST)`;
}

/**
 * Display string for plant column: name + optional plant type.
 */
export function formatPlantCell(plantName, plantType) {
  const name = (plantName || "—").trim() || "—";
  const type = (plantType || "").trim();
  return type ? `${name} (${type})` : name;
}

function subtypeLabelFromPlantDoc(plantDoc, subtypeId) {
  if (!plantDoc?.subtypes?.length || !subtypeId) {
    return "—";
  }
  const sid = String(subtypeId);
  const m = plantDoc.subtypes.find((s) => String(s._id) === sid);
  return m?.name ? String(m.name).trim() : "—";
}

function orderQuantity(order) {
  const t = Number(order.totalPlants);
  if (!Number.isNaN(t) && t > 0) {
    return t;
  }
  return (
    (Number(order.numberOfPlants) || 0) + (Number(order.additionalPlants) || 0)
  );
}

function villageDisplayLabel(farmer) {
  if (!farmer) {
    return "—";
  }
  const v = String(farmer.village || "").trim();
  const taluka = String(farmer.talukaName || farmer.taluka || "").trim();
  if (v && taluka) {
    return `${v} (${taluka})`;
  }
  return v || taluka || "—";
}

/**
 * Bookings from `orders` in date range (IST): orderBookingDate in range, or missing booking date + createdAt in range.
 * @param {{ start: Date, end: Date }} range
 */
async function fetchBookingReportDataFromOrdersForRange(range) {
  const { start, end } = range;

  const orders = await Order.find({
    orderStatus: { $nin: ["CANCELLED", "REJECTED"] },
    $or: [
      { orderBookingDate: { $gte: start, $lte: end } },
      {
        $and: [
          {
            $or: [
              { orderBookingDate: null },
              { orderBookingDate: { $exists: false } },
            ],
          },
          { createdAt: { $gte: start, $lte: end } },
        ],
      },
    ],
  })
    .populate(
      "farmer",
      "name mobileNumber village talukaName districtName district taluka"
    )
    .populate("plantName", "name subtypes")
    .sort({ orderBookingDate: 1, createdAt: 1 })
    .lean();

  /** @type {{ farmerName: string, plantName: string, plantType: string, subtype: string, quantity: number }[]} */
  const lineRows = [];

  /** @type {Record<string, Record<string, number>>} */
  const grouped = {};
  let grandTotal = 0;
  const farmerKeySet = new Set();
  /** @type {Map<string, { display: string, qty: number }>} */
  const farmerAgg = new Map();
  /** @type {Map<string, number>} */
  const villageQty = new Map();

  for (const row of orders) {
    const farmerName =
      (row.farmer?.name && String(row.farmer.name).trim()) || "—";
    const plantDoc = row.plantName;
    const plantDisplay =
      (plantDoc?.name && String(plantDoc.name).trim()) || "Unknown";
    const sub = subtypeLabelFromPlantDoc(plantDoc, row.plantSubtype);
    const qty = orderQuantity(row);

    lineRows.push({
      farmerName,
      plantName: plantDisplay,
      plantType: "",
      subtype: sub,
      quantity: qty,
    });

    if (!grouped[plantDisplay]) {
      grouped[plantDisplay] = {};
    }
    grouped[plantDisplay][sub] = (grouped[plantDisplay][sub] || 0) + qty;
    grandTotal += qty;

    if (farmerName && farmerName !== "—") {
      farmerKeySet.add(farmerName.toLowerCase());
      const fk = farmerName.toLowerCase();
      const prev = farmerAgg.get(fk);
      if (prev) {
        prev.qty += qty;
      } else {
        farmerAgg.set(fk, { display: farmerName, qty });
      }
    }

    const vLabel = villageDisplayLabel(row.farmer);
    if (vLabel && vLabel !== "—") {
      villageQty.set(vLabel, (villageQty.get(vLabel) || 0) + qty);
    }
  }

  const summaryRows = groupedToTableRows(grouped);

  const topFarmers = [...farmerAgg.values()]
    .sort((a, b) => b.qty - a.qty)
    .slice(0, 3)
    .map(({ display, qty }) => ({ name: display, quantity: qty }));

  const topVillages = [...villageQty.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([name, quantity]) => ({ name, quantity }));

  return {
    lineRows,
    summaryRows,
    grouped,
    stats: {
      grandTotal,
      bookingLines: orders.length,
      uniqueFarmers: farmerKeySet.size,
    },
    range: { start, end },
    source: "orders",
    topFarmers,
    topVillages,
  };
}

/**
 * Today's data from `orders` + PlantCms + Farmer (production bookings).
 */
async function fetchTodayBookingReportDataFromOrders() {
  const { start, end } = getTodayRangeIST();
  return fetchBookingReportDataFromOrdersForRange({ start, end });
}

/**
 * Legacy: standalone `bookings` collection only.
 */
async function fetchBookingReportDataFromBookingsCollectionForRange(range) {
  const { start, end } = range;

  const docs = await Booking.find({
    createdAt: { $gte: start, $lte: end },
  })
    .select({
      farmerName: 1,
      plantName: 1,
      plantType: 1,
      subtype: 1,
      quantity: 1,
    })
    .sort({ createdAt: 1 })
    .lean();

  /** @type {{ farmerName: string, plantName: string, plantType: string, subtype: string, quantity: number }[]} */
  const lineRows = [];

  /** @type {Record<string, Record<string, number>>} */
  const grouped = {};
  let grandTotal = 0;
  const farmerKeySet = new Set();
  /** @type {Map<string, { display: string, qty: number }>} */
  const farmerAgg = new Map();

  for (const row of docs) {
    const farmerName = (row.farmerName || "").trim() || "—";
    const plantName = (row.plantName || "Unknown").trim() || "Unknown";
    const plantType = (row.plantType || "").trim();
    const sub = (row.subtype || "—").trim() || "—";
    const qty = Number(row.quantity) || 0;

    lineRows.push({
      farmerName,
      plantName,
      plantType,
      subtype: sub,
      quantity: qty,
    });

    if (!grouped[plantName]) {
      grouped[plantName] = {};
    }
    grouped[plantName][sub] = (grouped[plantName][sub] || 0) + qty;
    grandTotal += qty;

    if (farmerName && farmerName !== "—") {
      farmerKeySet.add(farmerName.toLowerCase());
      const fk = farmerName.toLowerCase();
      const prev = farmerAgg.get(fk);
      if (prev) {
        prev.qty += qty;
      } else {
        farmerAgg.set(fk, { display: farmerName, qty });
      }
    }
  }

  const summaryRows = groupedToTableRows(grouped);

  const topFarmers = [...farmerAgg.values()]
    .sort((a, b) => b.qty - a.qty)
    .slice(0, 3)
    .map(({ display, qty }) => ({ name: display, quantity: qty }));

  return {
    lineRows,
    summaryRows,
    grouped,
    stats: {
      grandTotal,
      bookingLines: docs.length,
      uniqueFarmers: farmerKeySet.size,
    },
    range: { start, end },
    source: "bookings",
    topFarmers,
    topVillages: [],
  };
}

async function fetchTodayBookingReportDataFromBookingsCollection() {
  const { start, end } = getTodayRangeIST();
  return fetchBookingReportDataFromBookingsCollectionForRange({ start, end });
}

/**
 * Bookings for an arbitrary IST-inclusive date range (same rules as today).
 * @param {{ start: Date, end: Date }} range
 */
export async function fetchBookingReportDataForDateRange(range) {
  const src = getBookingReportSource();
  if (src === "bookings") {
    return fetchBookingReportDataFromBookingsCollectionForRange(range);
  }
  return fetchBookingReportDataFromOrdersForRange(range);
}

/**
 * Today's bookings for PDF: detail lines + aggregate summary + headline figures.
 * Default: farmer **orders** for today (IST). Set `BOOKING_REPORT_SOURCE=bookings` for legacy collection.
 */
export async function fetchTodayBookingReportData() {
  const src = getBookingReportSource();
  if (src === "bookings") {
    return fetchTodayBookingReportDataFromBookingsCollection();
  }
  return fetchTodayBookingReportDataFromOrders();
}

/**
 * Fetch today's bookings and aggregate Plant → Subtype → total quantity.
 * @deprecated Prefer fetchTodayBookingReportData for PDFs with farmer lines.
 */
export async function fetchTodayBookingsGrouped() {
  const data = await fetchTodayBookingReportData();
  return {
    grouped: data.grouped,
    grandTotal: data.stats.grandTotal,
    rowCount: data.stats.bookingLines,
    range: data.range,
  };
}

/**
 * Flatten grouped structure into table rows (sorted for stable PDF output).
 * @param {Record<string, Record<string, number>>} grouped
 * @returns {{ plant: string, subtype: string, quantity: number }[]}
 */
export function groupedToTableRows(grouped) {
  const rows = [];
  for (const [plant, subtypes] of Object.entries(grouped)) {
    for (const [subtype, quantity] of Object.entries(subtypes)) {
      rows.push({ plant, subtype, quantity });
    }
  }
  rows.sort(
    (a, b) =>
      a.plant.localeCompare(b.plant) || a.subtype.localeCompare(b.subtype)
  );
  return rows;
}

/**
 * Group summary rows under plant name for readable WhatsApp text.
 * @param {{ plant: string, subtype: string, quantity: number }[]} summaryRows
 */
function formatPlantSubtypeBlocksForWhatsApp(summaryRows) {
  /** @type {Record<string, { subtype: string, quantity: number }[]>} */
  const byPlant = {};
  for (const r of summaryRows) {
    const p = r.plant || "—";
    if (!byPlant[p]) {
      byPlant[p] = [];
    }
    byPlant[p].push({ subtype: r.subtype || "—", quantity: r.quantity });
  }
  const plants = Object.keys(byPlant).sort((a, b) => a.localeCompare(b));
  const lines = [];
  for (const plant of plants) {
    lines.push(`${plant}`);
    const subs = byPlant[plant].sort((a, b) =>
      a.subtype.localeCompare(b.subtype)
    );
    for (const { subtype, quantity } of subs) {
      lines.push(`  • ${subtype}: ${quantity}`);
    }
    lines.push("");
  }
  return lines;
}

/**
 * Short WhatsApp text with headline figures + plant→subtype breakdown (for WATI session message).
 * @param {string} reportDateLabel
 * @param {{ grandTotal: number, bookingLines: number, uniqueFarmers: number }} stats
 * @param {{ plant: string, subtype: string, quantity: number }[]} summaryRows
 */
export function formatBookingFiguresWhatsApp(
  reportDateLabel,
  stats,
  summaryRows,
  dataSource = "orders"
) {
  const sourceNote =
    dataSource === "bookings"
      ? "Data: standalone bookings collection"
      : "Data: farmer orders (today IST · booking date or created date)";
  const lines = [
    `Today's booking — ${reportDateLabel}`,
    sourceNote,
    "",
    "Summary",
    `Total qty (plants): ${stats.grandTotal}`,
    `Booking lines: ${stats.bookingLines}`,
    `Farmers (named): ${stats.uniqueFarmers}`,
    "",
  ];

  if (summaryRows.length) {
    lines.push("Plant-wise → Subtype & qty", "");
    lines.push(...formatPlantSubtypeBlocksForWhatsApp(summaryRows));
  } else {
    lines.push("Plant-wise: no entries yet.", "");
    if (getBookingReportSource() === "bookings") {
      lines.push(
        "No rows in the standalone bookings collection for today (IST).",
        ""
      );
    } else {
      lines.push(
        "No farmer orders for today (IST): we match orderBookingDate today,",
        "or createdAt today if booking date is empty (cancelled/rejected excluded).",
        ""
      );
    }
  }

  lines.push("──────────", "PDF file comes in the next message (when upload is configured).");

  let text = lines.join("\n").trimEnd();
  if (text.length > 3800) {
    text = `${text.slice(0, 3770)}…`;
  }
  return text;
}

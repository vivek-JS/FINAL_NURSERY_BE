import moment from "moment";
import Booking from "../models/Booking.js";

/** @type {readonly string[]} */
const REPORT_TRIGGER_PHRASES_EN = ["today booking", "booking report"];
const REPORT_TRIGGER_MARATHI = "आजचा बुकिंग रिपोर्ट";

/**
 * Whether the inbound WhatsApp text should trigger today's booking PDF flow.
 * @param {string} [messageText]
 */
export function shouldGenerateTodayBookingReport(messageText) {
  if (!messageText || typeof messageText !== "string") {
    return false;
  }
  const raw = messageText.trim();
  if (raw.includes(REPORT_TRIGGER_MARATHI)) {
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
  if (originalMessage && originalMessage.includes(REPORT_TRIGGER_MARATHI)) {
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
 * Display string for plant column: name + optional plant type.
 */
export function formatPlantCell(plantName, plantType) {
  const name = (plantName || "—").trim() || "—";
  const type = (plantType || "").trim();
  return type ? `${name} (${type})` : name;
}

/**
 * Today's bookings for PDF: detail lines + aggregate summary + headline figures.
 */
export async function fetchTodayBookingReportData() {
  const { start, end } = getTodayRangeIST();

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
    }
  }

  const summaryRows = groupedToTableRows(grouped);

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
  };
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
 * Short WhatsApp text with headline figures + plant×subtype breakdown (for WATI session message).
 * @param {string} reportDateLabel
 * @param {{ grandTotal: number, bookingLines: number, uniqueFarmers: number }} stats
 * @param {{ plant: string, subtype: string, quantity: number }[]} summaryRows
 */
export function formatBookingFiguresWhatsApp(
  reportDateLabel,
  stats,
  summaryRows
) {
  const lines = [
    `Today's booking — ${reportDateLabel}`,
    "",
    `Total qty: ${stats.grandTotal}`,
    `Lines: ${stats.bookingLines}`,
    `Farmers (named): ${stats.uniqueFarmers}`,
    "",
  ];
  if (summaryRows.length) {
    lines.push("Plant × subtype:");
    const maxLines = 40;
    const slice = summaryRows.slice(0, maxLines);
    for (const r of slice) {
      lines.push(`• ${r.plant} / ${r.subtype}: ${r.quantity}`);
    }
    if (summaryRows.length > maxLines) {
      lines.push(`… +${summaryRows.length - maxLines} more (see PDF)`);
    }
  } else {
    lines.push("No bookings today.");
  }
  lines.push("", "Detailed PDF follows.");
  let text = lines.join("\n");
  if (text.length > 3800) {
    text = `${text.slice(0, 3770)}…`;
  }
  return text;
}

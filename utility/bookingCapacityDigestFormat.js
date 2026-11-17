/**
 * Format date-wise FIFO booking capacity for WhatsApp admin digest.
 * Uses capacity-board ready/booked windows + canSellSlots.
 */
import moment from "moment";
import { IST_OFFSET } from "./istSlotDate.js";
import { canSellSlots } from "./canSellSlots.js";
import { splitWhatsAppChunks } from "./intradayOpsEnglishFormat.js";

const YMD = "YYYY-MM-DD";
const DMY = "DD-MM-YYYY";

function num(n) {
  return Number(n) || 0;
}

function fmtQty(n) {
  return Math.round(num(n)).toLocaleString("en-IN");
}

/** DD-MM-YYYY or YYYY-MM-DD → YYYY-MM-DD */
export function toYmd(value) {
  if (!value) return null;
  const raw = String(value).trim();
  const iso = moment(raw, YMD, true);
  if (iso.isValid()) return iso.format(YMD);
  const dmy = moment(raw, DMY, true);
  if (dmy.isValid()) return dmy.format(YMD);
  return null;
}

/** Compact date range for WhatsApp lines. */
export function formatRangeLabel(from, to) {
  const a = moment(from, YMD, true);
  const b = moment(to || from, YMD, true);
  if (!a.isValid()) return String(from || "—");
  if (!b.isValid() || a.isSame(b, "day")) return a.format("D MMM");
  if (a.month() === b.month() && a.year() === b.year()) {
    return `${a.format("D")}–${b.format("D MMM")}`;
  }
  return `${a.format("D MMM")}–${b.format("D MMM")}`;
}

/**
 * Build ordered ready/dispatch windows from one capacity-board variety row.
 * Past free cards first, then Now, then future cells — FIFO from earliest.
 */
export function windowsFromBoardRow(row, todayYmd) {
  const windows = [];
  const pushCell = (cell, { isNow = false } = {}) => {
    if (!cell) return;
    const from = toYmd(cell.startDay) || (isNow ? todayYmd : null);
    const to = toYmd(cell.endDay) || from;
    if (!from) return;
    const ready = num(cell.ready);
    const booked = num(cell.booked);
    if (ready <= 0 && booked <= 0 && num(cell.net) === 0) return;
    windows.push({
      key: cell.key || from,
      from,
      to: to || from,
      lagwad: ready,
      dispatch: booked,
      overdueDispatch: isNow ? num(cell.overdue?.booked) : 0,
    });
  };

  const past = [...(row?.pastCells || [])].sort((a, b) =>
    String(toYmd(a.startDay) || "").localeCompare(String(toYmd(b.startDay) || ""))
  );
  for (const cell of past) pushCell(cell);
  pushCell(row?.now || row?.current, { isNow: true });
  for (const cell of row?.cells || []) pushCell(cell);
  return windows;
}

/**
 * @returns {{ plantName: string, subtypeName: string, slots: object[], canBookTotal: number }[]}
 */
export function buildBookingCapacityVarieties(boardRows = [], todayYmd) {
  const out = [];
  for (const row of boardRows || []) {
    const windows = windowsFromBoardRow(row, todayYmd);
    if (!windows.length) continue;
    const slots = canSellSlots(windows);
    const canBookTotal = slots.reduce((sum, s) => sum + num(s.canSell), 0);
    const hasSignal = slots.some((s) => s.canSell > 0 || s.short > 0 || s.stillToGive > 0);
    if (!hasSignal) continue;
    out.push({
      plantName: row.plantName || "—",
      subtypeName: row.subtypeName || "—",
      plantId: row.plantId,
      subtypeId: row.subtypeId,
      slots,
      canBookTotal,
    });
  }
  out.sort(
    (a, b) =>
      b.canBookTotal - a.canBookTotal ||
      a.plantName.localeCompare(b.plantName) ||
      a.subtypeName.localeCompare(b.subtypeName)
  );
  return out;
}

function formatSlotLine(slot) {
  const range = formatRangeLabel(slot.from, slot.to);
  if (slot.canSell > 0) {
    const hold =
      slot.reservedForLater > 0 ? ` (hold ${fmtQty(slot.reservedForLater)} for later)` : "";
    return `• ${range}: can book *${fmtQty(slot.canSell)}*${hold}`;
  }
  if (slot.short > 0) {
    return `• ${range}: short *${fmtQty(slot.short)}* — don't book`;
  }
  if (slot.stillToGive > 0 && slot.available > 0) {
    return `• ${range}: covered (still to give ${fmtQty(slot.stillToGive)})`;
  }
  return null;
}

/**
 * Build WhatsApp message chunks for date-wise FIFO booking capacity.
 */
export function formatBookingCapacityDigestMessages({
  varieties = [],
  today,
  tableDays = 30,
  generatedAt,
} = {}) {
  const todayLabel = moment(today, YMD, true).isValid()
    ? moment(today, YMD).format("D MMM YYYY")
    : moment().utcOffset(IST_OFFSET).format("D MMM YYYY");

  const withBook = varieties.filter((v) => v.canBookTotal > 0 || v.slots.some((s) => s.short > 0));
  if (!withBook.length) {
    return {
      chunks: [],
      totalCanBook: 0,
      varietyCount: 0,
      empty: true,
    };
  }

  const totalCanBook = withBook.reduce((sum, v) => sum + num(v.canBookTotal), 0);
  const header = [
    "📦 *Booking capacity (FIFO)*",
    `_Date-wise how much you can book · next ${tableDays} days_`,
    `_${todayLabel}_`,
    "",
    `*Total can book: ${fmtQty(totalCanBook)}* across ${withBook.length} varieties`,
    "",
  ];

  const blocks = [];
  for (const v of withBook) {
    const lines = [`*${v.plantName} / ${v.subtypeName}*`];
    for (const slot of v.slots) {
      const line = formatSlotLine(slot);
      if (line) lines.push(line);
    }
    if (v.canBookTotal > 0) {
      lines.push(`_Variety total: ${fmtQty(v.canBookTotal)}_`);
    }
    lines.push("");
    blocks.push(lines.join("\n"));
  }

  const body = header.join("\n") + blocks.join("\n").trimEnd();
  const stamp = generatedAt
    ? `\n\n_Generated ${moment(generatedAt).utcOffset(IST_OFFSET).format("D MMM, h:mm A")}_`
    : "";
  const chunks = splitWhatsAppChunks(body + stamp);

  return {
    chunks,
    totalCanBook,
    varietyCount: withBook.length,
    empty: false,
  };
}

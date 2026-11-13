import moment from "moment";
import {
  BOARD_TABLE_DAYS,
  OVERDUE_LOOKBACK_DAYS,
  buildBoardRow,
  parseGroupDays,
} from "../../utility/capacityBoardMetrics.js";
import { IST_OFFSET } from "../../utility/istSlotDate.js";
import { sowDayFrom, toSowingEntryListItem } from "./mapSowingEntry.js";

function ymdMinusDays(ymd, days) {
  const match = String(ymd || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return "";
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  date.setUTCDate(date.getUTCDate() - Math.max(0, Number(days) || 0));
  return date.toISOString().slice(0, 10);
}

function dmy(ymd) {
  const match = String(ymd || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return "";
  return `${match[3]}-${match[2]}-${match[1]}`;
}

/**
 * Same date cards as the capacity board, using sowingentries excess.
 * Ready today or earlier sits on Now. Later ready days stay on that day.
 * Older than the board lookback is left out. Does not change the old board.
 */
export function rowsFromEntries(docs, { today, groupDays = 1 } = {}) {
  const day = today.clone().startOf("day");
  const todayYmd = day.format("YYYY-MM-DD");
  const cutoff = ymdMinusDays(todayYmd, OVERDUE_LOOKBACK_DAYS);
  const byVariety = new Map();

  for (const doc of docs || []) {
    const item = toSowingEntryListItem(doc);
    const excess = Math.max(0, Math.floor(Number(item.excessPlants) || 0));
    if (excess < 1 || item.isIrrelevant) continue;
    const plantId = String(item.plantId || "");
    const subtypeId = String(item.subtypeId || "");
    if (!plantId || !subtypeId) continue;
    const ready = sowDayFrom(item.plantReadyDate);
    if (ready && cutoff && ready < cutoff) continue;
    const key = `${plantId}|${subtypeId}`;
    if (!byVariety.has(key)) byVariety.set(key, new Map());
    const bucket = !ready || ready <= todayYmd ? todayYmd : ready;
    const days = byVariety.get(key);
    days.set(bucket, (days.get(bucket) || 0) + excess);
  }

  const rows = [];
  for (const [key, days] of byVariety) {
    const [plantId, subtypeId] = key.split("|");
    const slots = [];
    for (const [readyYmd, excess] of days) {
      const startDay = dmy(readyYmd);
      if (!startDay) continue;
      slots.push({
        startDay,
        endDay: startDay,
        booked: 0,
        gap: 0,
        excess,
        mortality: 0,
      });
    }
    const built = buildBoardRow({ slots, today: day, groupDays });
    const cells = (built.cells || []).map((cell) => ({
      key: cell.key,
      startDay: cell.startDay,
      endDay: cell.endDay,
      excess: Math.max(0, Math.floor(Number(cell.net) || 0)),
    }));
    const now = Math.max(0, Math.floor(Number(built.now?.net) || 0));
    const future = cells.reduce((sum, cell) => sum + cell.excess, 0);
    if (now + future < 1) continue;
    rows.push({ plantId, subtypeId, total: now + future, now, cells });
  }
  return rows;
}

export function boardToday() {
  return moment().utcOffset(IST_OFFSET).startOf("day");
}

export function boardGroup(value) {
  return parseGroupDays(value);
}

export { BOARD_TABLE_DAYS };

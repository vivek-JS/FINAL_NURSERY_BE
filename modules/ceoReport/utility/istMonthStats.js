import moment from "moment";
import { istDayBoundsFromYmd } from "../../../utility/istOrderDateStats.js";

export const IST = "Asia/Kolkata";

/** Inclusive IST calendar months from startYmd through endYmd (YYYY-MM). */
export function generateIstMonthKeys(startYmd, endYmd) {
  const keys = [];
  const cur = moment(startYmd, "YYYY-MM-DD").utcOffset(330).startOf("month");
  const end = moment(endYmd, "YYYY-MM-DD").utcOffset(330).startOf("month");
  while (cur.isSameOrBefore(end, "month")) {
    keys.push(cur.format("YYYY-MM"));
    cur.add(1, "month");
  }
  return keys;
}

export function monthBoundsFromYm(ym) {
  const m = moment(ym, "YYYY-MM").utcOffset(330);
  if (!m.isValid()) return null;
  const startYmd = m.startOf("month").format("YYYY-MM-DD");
  const endYmd = m.endOf("month").format("YYYY-MM-DD");
  return {
    ym,
    startYmd,
    endYmd,
    rangeStart: istDayBoundsFromYmd(startYmd).start,
    rangeEnd: istDayBoundsFromYmd(endYmd).end,
    label: m.format("MMM YYYY"),
  };
}

export function istMonthStringExpr(dateField) {
  return {
    $dateToString: {
      format: "%Y-%m",
      date: `$${dateField}`,
      timezone: IST,
    },
  };
}

export function dayKeyToMonthKey(dayKey) {
  return String(dayKey || "").slice(0, 7);
}

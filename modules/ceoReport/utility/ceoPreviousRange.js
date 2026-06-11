import moment from "moment";
import { parseYmdRange } from "../../../utility/istOrderDateStats.js";
import { monthBoundsFromYm, IST } from "./istMonthStats.js";

/** Previous calendar month when range is a full month; else same-length window before start. */
export function resolvePreviousRange(startYmd, endYmd) {
  const startM = moment(startYmd, "YYYY-MM-DD").utcOffset(330);
  const endM = moment(endYmd, "YYYY-MM-DD").utcOffset(330);
  const isFullMonth =
    startM.date() === 1 &&
    endM.date() === endM.daysInMonth() &&
    startM.format("YYYY-MM") === endM.format("YYYY-MM");

  if (isFullMonth) {
    const prevYm = startM.clone().subtract(1, "month").format("YYYY-MM");
    const bounds = monthBoundsFromYm(prevYm);
    if (!bounds) return null;
    return {
      startYmd: bounds.startYmd,
      endYmd: bounds.endYmd,
      rangeStart: bounds.rangeStart,
      rangeEnd: bounds.rangeEnd,
      label: bounds.label,
    };
  }

  const parsed = parseYmdRange(startYmd, endYmd);
  if (parsed.error) return null;
  const { dayCount, rangeStart } = parsed;
  const prevEndMs = rangeStart.getTime() - 1;
  const prevStartMs = prevEndMs - (dayCount - 1) * 86400000;
  const fmt = (ms) => new Date(ms).toLocaleDateString("en-CA", { timeZone: IST });
  const prevStartYmd = fmt(prevStartMs);
  const prevEndYmd = fmt(prevEndMs);
  const prevParsed = parseYmdRange(prevStartYmd, prevEndYmd);
  if (prevParsed.error) return null;
  return {
    startYmd: prevStartYmd,
    endYmd: prevEndYmd,
    rangeStart: prevParsed.rangeStart,
    rangeEnd: prevParsed.rangeEnd,
    label: `${prevStartYmd} → ${prevEndYmd}`,
  };
}

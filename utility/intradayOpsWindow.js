import moment from "moment";

export const INTRADAY_WINDOW_MS = 2.5 * 60 * 60 * 1000;

/** Rolling [from, to) ending at `to` (default now). */
export function intradayWindowBounds(to = new Date(), windowMs = INTRADAY_WINDOW_MS) {
  const end = new Date(to);
  const start = new Date(end.getTime() - windowMs);
  return { from: start, to: end };
}

/** IST clock labels for the report header / footer. */
export function formatIntradayWindowLabels(from, to) {
  const start = moment(from).utcOffset(330);
  const end = moment(to).utcOffset(330);
  return {
    fromLabel: start.format("HH:mm"),
    toLabel: end.format("HH:mm"),
    dateLabel: end.format("DD MMM YYYY"),
    runLabel: end.format("h:mm A"),
    rangeLabel: `${start.format("HH:mm")} – ${end.format("HH:mm")} IST · ${end.format("DD MMM YYYY")}`,
  };
}

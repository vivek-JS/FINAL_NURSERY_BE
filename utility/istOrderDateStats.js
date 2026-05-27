import moment from "moment";

export const IST_TIMEZONE = "Asia/Kolkata";

export const ORDER_EXCLUDED_STATUSES = [
  "CANCELLED",
  "REJECTED",
  "TEMPORARY_CANCELLED",
];

/** Mongo $addFields fragment: numberOfPlants + additionalPlants */
export const LINE_PLANT_TOTAL_ADD_FIELDS = {
  linePlantTotal: {
    $add: [
      { $ifNull: ["$numberOfPlants", 0] },
      { $ifNull: ["$additionalPlants", 0] },
    ],
  },
};

export function istDayBoundsFromYmd(dateKey) {
  const start = new Date(`${dateKey}T00:00:00+05:30`);
  const end = new Date(`${dateKey}T23:59:59.999+05:30`);
  return { start, end };
}

export function getIstTodayYmd() {
  return moment().utcOffset(330).format("YYYY-MM-DD");
}

export function getIstYesterdayYmd() {
  return moment().utcOffset(330).subtract(1, "day").format("YYYY-MM-DD");
}

/** Inclusive IST calendar days from startYmd through endYmd (YYYY-MM-DD). */
export function generateIstDateKeys(startYmd, endYmd) {
  const keys = [];
  const cur = moment(startYmd, "YYYY-MM-DD").utcOffset(330).startOf("day");
  const end = moment(endYmd, "YYYY-MM-DD").utcOffset(330).startOf("day");
  while (cur.isSameOrBefore(end, "day")) {
    keys.push(cur.format("YYYY-MM-DD"));
    cur.add(1, "day");
  }
  return keys;
}

export function parseYmdRange(startDate, endDate) {
  const startYmd = String(startDate || "").slice(0, 10);
  const endYmd = String(endDate || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startYmd) || !/^\d{4}-\d{2}-\d{2}$/.test(endYmd)) {
    return { error: "startDate and endDate are required (YYYY-MM-DD)" };
  }
  const startMoment = moment(startYmd, "YYYY-MM-DD").utcOffset(330).startOf("day");
  const endMoment = moment(endYmd, "YYYY-MM-DD").utcOffset(330).startOf("day");
  if (!startMoment.isValid() || !endMoment.isValid()) {
    return { error: "Invalid date format" };
  }
  if (endMoment.isBefore(startMoment)) {
    return { error: "endDate must be on or after startDate" };
  }
  const dayCount = endMoment.diff(startMoment, "days") + 1;
  return {
    startYmd,
    endYmd,
    dayCount,
    rangeStart: istDayBoundsFromYmd(startYmd).start,
    rangeEnd: istDayBoundsFromYmd(endYmd).end,
    dateKeys: generateIstDateKeys(startYmd, endYmd),
  };
}

export function orderStatusExcludeMatch() {
  return { orderStatus: { $nin: ORDER_EXCLUDED_STATUSES } };
}

export function istDateStringExpr(dateField) {
  return {
    $dateToString: {
      format: "%Y-%m-%d",
      date: `$${dateField}`,
      timezone: IST_TIMEZONE,
    },
  };
}

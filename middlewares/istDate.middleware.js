/**
 * Global IST date normalization — runs on every API request after body parsing.
 *
 * - Attaches req.ist (calendar helpers) and req.istQuery (parsed date ranges).
 * - Normalizes deliveryDate / dispatchTargetDate on write bodies to IST midnight.
 * - Controllers should prefer req.istQuery.range over raw UTC Date parsing.
 */
import * as ist from "../utility/istCalendar.js";

export default function istDateMiddleware(req, res, next) {
  req.ist = ist;

  if (req.body && typeof req.body === "object" && !Array.isArray(req.body)) {
    req.istBodyNormalized = ist.normalizeBodyIstCalendarDates(req.body);
  } else {
    req.istBodyNormalized = [];
  }

  const range = ist.parseQueryIstDateRange(req.query);
  if (range) {
    req.istQuery = { range };
  } else {
    req.istQuery = {};
  }

  next();
}

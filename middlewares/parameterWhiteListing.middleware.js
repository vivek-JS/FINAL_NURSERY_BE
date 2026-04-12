import AppError from "../utility/appError.js";

/** Normalize path for routing checks (Express may set path/originalUrl/url differently behind proxies). */
function stripQuery(url) {
  if (typeof url !== "string") return "";
  const q = url.indexOf("?");
  return q === -1 ? url : url.slice(0, q);
}

/** Do not whitelist-query-filter lab routes (many dynamic params). Use substring match so BOM/weird encoding cannot break startsWith. */
function shouldSkipQueryWhitelist(req) {
  const blob = [
    stripQuery(req.originalUrl),
    stripQuery(req.url),
    typeof req.path === "string" ? req.path : "",
  ].join("\0");
  return blob.includes("laboutward");
}

const allowedParams = [
  "stateId",
  "districtId",
  "subDistrictId",
  "startDate",
  "endDate",
  "days", // Rolling-day window for easy sowing cards API
  "dateFrom", // ERP payment reconciliation (unverified / for-approval lists)
  "dateTo",
  "sortKey",
  "sortOrder",
  "search",
  "page",
  "limit",
  "status",
  "paymentStatus",
  "plantId",
  "subtypeId",
  "year",
  "minNumberPerCrate",
  "maxNumberPerCrate",
  "jobTitle",
  "id",
  "transportId",
  "name",
  "entity",
  "mobileNumber",
  "phone",
  "slotId",
  "actionType",
  "orderId",
  "orderIds",
  "userId",
  "date",
  "fromDate",
  "dispatched",
  "includePastDueBeyondRange",
  "dateRangeField", // getOrders: booking | delivery — which field startDate/endDate apply to
  "exportAll", // getOrders: "true" = full export (high limit, no early pagination)
  "salesPerson",
  "monthName",
  "startDay",
  "endDay",
  "village",
  "district",
  "districtName",
  "talukaName",
  "dealer",
  "farmReady",
  "ready_for_dispatch",
  "isActive",
  "category",
  "sortBy",
  "sortOrder",
  "backDays",
  "forwardDays",
  "timeRange",
  "_t", // Timestamp parameter for cache busting
  "t", // Alternative timestamp parameter
  "lookahead", // For alerts/reminders
  "pastWindow", // For alerts/reminders
  "priority", // For filtering by priority (overdue, urgent, upcoming - future is excluded)
  "sourceType", // For task filters (manual/call_assignment)
  "current", // Show only current priorities (urgent + upcoming), excludes future and overdue
  "showAvailable", // For showing available plants
  "showGap", // For showing booking gap
  "gapFilter", // For filtering by gap type: "positive", "negative", "zero", or "all"
  "minAvailable", // Minimum available plants threshold
  "showPendingOnly", // For showing pending sowings only
  "showOverdueOnly", // For showing overdue sowings only
  "toDate", // End date for date range filters
  "available", // For plants-gap-summary: return negative gaps (available/surplus) instead of positive gaps
  "level", // For bucketing endpoints (order/inventory bucketing)
  "month", // For bucketing endpoints (month-level grouping)
  "day", // For bucketing endpoints (day-level grouping)
  "salesPersonId", // For salesmen bucketing endpoints
  "taluka", // For salesmen bucketing endpoints (geographical grouping)
  "groupBy", // For geo-summary endpoint (taluka | village aggregation)
    // Agri Sales Order parameters
    "orderStatus", // For filtering by order status (PENDING, ACCEPTED, REJECTED, etc.)
    "dispatchStatus", // For filtering by dispatch status (DISPATCHED, IN_TRANSIT, DELIVERED, etc.)
    "productId", // For filtering by product ID
    "customerMobile", // For filtering by customer mobile number
    "farmer", // Farmer plant ledger (ObjectId)
  "farmerId", // remaining-dispatch-matrix-orders
  "columnKey", // remaining-dispatch-matrix-orders (plant subtype label)
  "matrixRole", // sales | dealer
  "rowId", // matrix row (salesPerson or dealer id, or none)
    "linesOnly", // Farmer plant ledger: include line entries
    "customerName", // For filtering by customer name
    "customerId", // For filtering by customer ID
    "isAgriSales", // For filtering products by Agri Sales flag
    "createdBy", // For filtering orders by creator (employee who created)
  "mine", // For restricting list APIs to current user entries
    "myOrders", // Boolean: show only current user's orders
    "showonly", // For restricting getOrders to the logged-in user's own orders (overrides role-based access for admins)
    "paymentStatus", // For filtering by payment status (PENDING, PARTIAL, COMPLETED)
  // Old sales analytics filters
  "plant",
  "variety",
  "media",
  "batch",
  "paymentMode",
  "reference",
  "marketingReference",
  "billGivenOrNot",
  "verifiedOrNot",
  "bookingNo",
  "mobileNo",
  "shadeNo",
  "vehicleNo",
  "driverName",
  "ownerId", // GET /vehicles/all — filter vehicles by VehicleOwner
  // Old sales data quality parameters
  "field",
  "minSimilarity",
  "maxSimilarity",
  "minCount",
  "referenceLimit",
  "suggestionLimit",
  "normalizedKey",
  "minVariants",
  "limit",
  "minOrders",
  "sortBy",
  "sortOrder",
    // Ram Agri Ledger parameters
    "cropId", // For Ram Agri variety ledger (crop ID)
    "varietyId", // For Ram Agri variety ledger (variety ID)
    "merchantId", // For Ram Agri merchant ledger (merchant ID)
  "productType", // For Ram Agri inputs filter (seed/chemical)
  "period", // For Ram Agri video summary (day/week)
  // WATI proxy
  "pageSize",
  "pageNumber",
  "channelPhoneNumber",
  "q",
  // Call assignment combined list
  "source", // farmer | lead | farmerForm | all
  "stateName",
  "linkId", // public farmer link id for farmer form filter
  "opt_in", // filter by opt-in status (true/false)
  "includeAll", // include all records (don't exclude those in call lists)
  "upcomingDays", // laboutward primary-mobile-dashboard window
  "orderLimit", // analytics short-report: max orders in list (cap 500)
];

/** Effective whitelist: array + mandatory extras (survives accidental removal from `allowedParams`). */
const allowedQueryKeys = new Set(allowedParams);
allowedQueryKeys.add("dateRangeField"); // GET /order/getOrders — booking | delivery date range

const parameterWhiteListing = (req, res, next) => {
  // First: lab / plant outward — never apply global query whitelist (batchId, upcomingDays, …)
  if (shouldSkipQueryWhitelist(req)) {
    return next();
  }

  // Skip parameter validation for login route
  if (req.path === '/api/v1/user/login' && req.method === 'POST') {
    return next();
  }

  // Skip parameter validation for public-links endpoints (completely public)
  if (req.path.startsWith('/api/v1/public-links/config/') || 
      req.path.startsWith('/api/v1/public-links/leads')) {
    return next();
  }

  // Skip parameter validation for WhatsApp webhook (completely public, no params needed)
  if (req.path === '/api/v1/whatsapp-order/webhook' || 
      req.originalUrl === '/api/v1/whatsapp-order/webhook') {
    return next();
  }

  // Skip parameter validation for WATI proxy (query params: pageSize, pageNumber, channelPhoneNumber)
  if (req.path.startsWith('/api/v1/wati')) {
    return next();
  }

  // ERP ICICI / payment reconciliation — mounted at /api/payments (dateFrom, dateTo, source, …)
  const paymentsPath = stripQuery(req.originalUrl || req.url || "") || req.path || "";
  if (paymentsPath.startsWith("/api/payments") || (req.path && req.path.startsWith("/api/payments"))) {
    return next();
  }

  // Only check query parameters, not path parameters (path params are defined in routes)
  const requestParams = req.query || {};

  // Check all query parameter keys (empty string values are still valid parameters)
  const invalidParams = Object.keys(requestParams).filter(
    (param) => !allowedQueryKeys.has(param)
  );

  if (invalidParams.length > 0) {
    console.log("❌ Invalid query parameters detected:", invalidParams);
    console.log("Request path:", req.path);
    console.log("Request method:", req.method);
    console.log("Query params:", requestParams);
    return next(new AppError(`Invalid parameters: ${invalidParams.join(", ")}`, 400));
  }

  next();
};

export default parameterWhiteListing;

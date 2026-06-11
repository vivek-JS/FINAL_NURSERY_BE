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
  "aggregate", // GET dispatch-outstanding-orders — aggregate=villages
  "status",
  "paymentStatus",
  "plantId",
  "subtypeId",
  "year",
  "onlyAvailable", // GET /slots/availability-overview
  "minNumberPerCrate",
  "maxNumberPerCrate",
  "jobTitle",
  "id",
  "transportId",
  "transportStatus", // GET /api/v1/dispatched — filter by vehicle status
  "paged", // GET /api/v1/dispatched — "1" enables paged list + pagination metadata
  "name",
  "entity",
  "mobileNumber",
  "phone",
  "slotId",
  "types", // GET /api/v1/slot-trail/:slotId — e.g. stock = stock-related trail actions only
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
  "sortByDelivery", // getOrders ready tab: "true" = sort by deliveryDate
  "sortByReadyEntered", // getOrders ready tab: "true" = sort by readyForDispatchEnteredAt (default = dispatchTargetDate)
  "queueFarmReadyOnly", // FarmerOrdersTable: ready-for-dispatch "Farm-ready on file" queue filter
  "plantTotals", // GET /order/getOrders — include totalPlantsSum for all matching rows (with pagination)
  "needsDispatch", // GET /order/getOrders — pre-dispatch pipeline status preset
  "expectedNursery", // GET /order/getOrders — filter by nursery site code (RB, GH, …)
  "isActive",
  "activeOnly", // GET /api/v1/nursery-sites — "true" filters to active sites only
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
  "paymentTiming", // GET /order/payments — advance | balance
  "pendingAdvanceOnly", // GET /order/payments — shorthand PENDING + advance
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
  "stockSort", // GET /inventory/ram-agri-sales-dashboard — stockItems sort field
  "stockOrder", // GET /inventory/ram-agri-sales-dashboard — asc | desc
  "stockCropId", // GET /inventory/ram-agri-sales-dashboard — filter by plant/crop
  "stockSearch", // GET /inventory/ram-agri-sales-dashboard — crop/variety search
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
  "dueOnly", // GET /insights/dashboard + admin MIS — overdue open orders only
  "depth", // GET /ceo-report/* — summary | periods | full
  "granularity", // GET /ceo-report/order-delivery-flow — day | month
  "includePastDue", // GET /ceo-report/* — synthetic past-due row
  "includeFuture", // GET /ceo-report/* — synthetic future row
  "periodKey", // GET /ceo-report/.../breakdown — drill period
  "changeDirection", // GET /ceo-report/orders — early | late delivery changes
  "futureDeliveryOnly", // GET /ceo-report/orders — future backlog drill
  "nurserySite", // GET /ceo-report/* — nursery site filter
  "comparePrevious", // GET /ceo-report/* — prior-period comparison
  "branchId", // GET /ceo-report/territory-collections — branch drill filter
  "includeAllPastDue", // GET /order/admin-*-mis — include delivery backlog before range start
  "bucket", // GET /order/admin-mis-orders — MIS column bucket
  "mode", // GET /order/admin-mis-orders — booking | delivery
  "pastDueOnly", // GET /order/admin-mis-orders — backlog before range
  "drawerSegment", // GET /order/admin-mis-orders — inRange | pastDue (split drawer)
  "date", // GET /order/admin-mis-orders — single IST day (YYYY-MM-DD)
  "excludeReadyForDispatch", // GET /insights/dashboard — omit READY_FOR_DISPATCH from expected KPIs
  "varietyName", // GET /insights/dashboard — plant subtype name with plantId
  "dateField", // GET /insights/collections/overview — booking | delivery date range field
  "paymentBucket", // GET /insights/collections/overview — all | has_collected | has_pending | fully_paid | partial | unpaid
  "paymentBuckets", // GET /insights/collections/overview — comma-separated payment bucket filters
  "paymentStatuses", // GET /insights/collections/overview — COLLECTED,PENDING on payment lines
  "paymentTypes", // GET /insights/collections/overview — advance,after_dispatch timing on payment lines
  "salesPersonIds", // GET /insights/collections/overview — comma-separated salesperson ObjectIds
  "advanceOnly", // GET /insights/collections/overview — payment-entry view (advance lines)
  "excludeTestFarmers", // GET /insights/collections/overview — exclude internal test farmer mobiles
  // One-click agri load link params
  "orderNumber",
  "actorPhone",
];

/** Effective whitelist: array + mandatory extras (survives accidental removal from `allowedParams`). */
const allowedQueryKeys = new Set(allowedParams);
allowedQueryKeys.add("dateRangeField"); // GET /order/getOrders — booking | delivery date range
allowedQueryKeys.add("dateField"); // GET /insights/collections/overview (alias of dateRangeField)
allowedQueryKeys.add("plantTotals"); // GET /order/getOrders — totalPlantsSum envelope (must survive merges)
allowedQueryKeys.add("needsDispatch"); // GET /order/getOrders — yet-to-dispatch status preset
allowedQueryKeys.add("expectedNursery"); // GET /order/getOrders — nursery site filter
allowedQueryKeys.add("queueFarmReadyOnly"); // GET /order/dashboard-tab-counts + ready tab queue filter
allowedQueryKeys.add("aggregate"); // GET /user/dealers/:id/dispatch-outstanding-orders?villages
allowedQueryKeys.add("paged"); // GET /dispatched — pagination toggle (also in allowedParams; duplicate for safety)
allowedQueryKeys.add("transportStatus"); // GET /dispatched filter
allowedQueryKeys.add("includeAllPastDue"); // admin MIS due backlog toggle
allowedQueryKeys.add("_"); // cache-bust query param (admin MIS)
allowedQueryKeys.add("forceResend"); // POST order send-*-whatsapp — unlimited test resend
allowedQueryKeys.add("templateType"); // GET /order/whatsapp/outbound — filter by template
allowedQueryKeys.add("batchId"); // GET /order/whatsapp/outbound — campaign batch filter ("none" = unbatched)
allowedQueryKeys.add("paymentTiming"); // GET /order/payments
allowedQueryKeys.add("pendingAdvanceOnly"); // GET /order/payments accountant dashboard
allowedQueryKeys.add("stockSort");
allowedQueryKeys.add("stockOrder");
allowedQueryKeys.add("stockCropId");
allowedQueryKeys.add("stockSearch");

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

  // Skip parameter validation for WATI webhooks (public POST, no query params needed)
  const webhookPath = stripQuery(req.originalUrl || req.url || "") || req.path || "";
  if (
    webhookPath === "/api/v1/whatsapp-order/webhook" ||
    webhookPath.startsWith("/api/v1/opt-in/webhook") ||
    webhookPath.startsWith("/api/v1/whatsapp-status/webhook")
  ) {
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

  /**
   * Farmer order list + dashboard tab counts evolve new filter flags often (e.g. plantTotals).
   * getOrders / dashboard-tab-counts only read a fixed set of query keys in the controller;
   * unknown keys are ignored, so skipping the global whitelist here avoids false 400s when
   * clients are ahead of this allowlist or multiple BE copies exist.
   */
  const orderListPath = stripQuery(req.originalUrl || req.url || "") || req.path || "";
  if (
    req.method === "GET" &&
    (orderListPath.includes("/order/getOrders") ||
      orderListPath.includes("/order/dashboard-tab-counts"))
  ) {
    return next();
  }

  /**
   * Dispatch list (`GET /api/v1/dispatched`) gains query flags often (`paged`, filters).
   * Same rationale as getOrders — controller ignores unknown keys; skip global whitelist for the list URL only.
   */
  const dispatchListOnly =
    stripQuery(req.originalUrl || req.url || req.path || "") || "";
  if (
    req.method === "GET" &&
    (dispatchListOnly === "/api/v1/dispatched" || dispatchListOnly === "/api/v1/dispatched/")
  ) {
    return next();
  }

  /** Agri insights hub — dashboard + collections evolve query flags; controllers ignore unknown keys. */
  const insightsPath = stripQuery(req.originalUrl || req.url || req.path || "") || "";
  if (req.method === "GET" && insightsPath.includes("/api/v1/insights")) {
    return next();
  }

  /** Admin MIS + CEO report — daily / sales / dealer breakdowns (dueOnly, depth, granularity, …). */
  if (
    req.method === "GET" &&
    (orderListPath.includes("/order/admin-daily-mis") ||
      orderListPath.includes("/order/admin-mis-sales") ||
      orderListPath.includes("/order/admin-mis-dealer") ||
      orderListPath.includes("/order/admin-mis-due") ||
      orderListPath.includes("/order/admin-mis-orders") ||
      orderListPath.includes("/order/central-report") ||
      orderListPath.includes("/ceo-report"))
  ) {
    return next();
  }

  /** Central ledger / finance reports — partyType, partyId, accountCode, branchId, etc. */
  if (insightsPath.includes("/api/v1/finance")) {
    return next();
  }

  /** Ram Agri sales dashboard / stock filters — stockSort, stockOrder, stockCropId, stockSearch, … */
  if (
    req.method === "GET" &&
    insightsPath.includes("/api/v1/inventory/ram-agri-sales-dashboard")
  ) {
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

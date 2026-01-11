import catchAsync from "../utility/catchAsync.js";
import AppError from "../utility/appError.js";

const allowedParams = [
  "stateId",
  "districtId",
  "subDistrictId",
  "startDate",
  "endDate",
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
  "slotId",
  "orderId",
  "orderIds",
  "date",
  "fromDate",
  "dispatched",
  "salesPerson",
  "monthName",
  "startDay",
  "endDay",
  "village",
  "district",
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
    // Agri Sales Order parameters
    "orderStatus", // For filtering by order status (PENDING, ACCEPTED, REJECTED, etc.)
    "productId", // For filtering by product ID
    "customerMobile", // For filtering by customer mobile number
    "customerName", // For filtering by customer name
    "customerId", // For filtering by customer ID
    "isAgriSales", // For filtering products by Agri Sales flag
    "createdBy", // For filtering orders by creator (employee who created)
    "myOrders", // Boolean: show only current user's orders
    "paymentStatus", // For filtering by payment status (PENDING, PARTIAL, COMPLETED)
    // Ram Agri Ledger parameters
    "cropId", // For Ram Agri variety ledger (crop ID)
    "varietyId", // For Ram Agri variety ledger (variety ID)
    "merchantId", // For Ram Agri merchant ledger (merchant ID)
];

const parameterWhiteListing = (req, res, next) => {
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

  // Only check query parameters, not path parameters (path params are defined in routes)
  const requestParams = req.query || {};

  // Check all query parameter keys (empty string values are still valid parameters)
  const invalidParams = Object.keys(requestParams).filter(
    (param) => !allowedParams.includes(param)
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

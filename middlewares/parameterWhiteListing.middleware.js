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
];

const parameterWhiteListing = (req, res, next) => {
  // Skip parameter validation for login route
  if (req.path === '/api/v1/user/login' && req.method === 'POST') {
    return next();
  }

  const requestParams = { ...req.query, ...req.params };

  const invalidParams = Object.keys(requestParams).filter(
    (param) => !allowedParams.includes(param)
  );

  if (invalidParams.length > 0) {
    next(new AppError("Invalid parameters", 400));
  }

  next();
};

export default parameterWhiteListing;

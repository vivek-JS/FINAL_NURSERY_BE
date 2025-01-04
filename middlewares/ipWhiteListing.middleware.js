import catchAsync from "../utility/catchAsync.js";
import AppError from "../utility/appError.js";

const IPWhiteListing = catchAsync(async (req, res, next) => {
  const allowedIPs = ["127.0.0.1", "::1", "192.168.1.100"];

  const clientIP =
    req.headers["x-forwarded-for"] || req.socket.remoteAddress || req.ip;

  if (allowedIPs.includes(clientIP)) {
    next();
  } else {
    next(new AppError("Access Denied. Your IP is not allowed.", 403));
  }
});

export default IPWhiteListing;

import generateResponse from "../utility/responseFormat.js";

const requestCounts = new Map();
const RATE_LIMIT_WINDOW = 15 * 60 * 1000;
const MAX_REQUESTS = 20;

const cleanup = () => {
  const now = Date.now();
  for (const [key, value] of requestCounts.entries()) {
    if (now - value.resetTime > RATE_LIMIT_WINDOW) {
      requestCounts.delete(key);
    }
  }
};

setInterval(cleanup, RATE_LIMIT_WINDOW);

export const rateLimitPublic = (req, res, next) => {
  const ip = req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
    req.headers["x-real-ip"] ||
    req.connection?.remoteAddress ||
    req.ip ||
    "unknown";

  const now = Date.now();
  const key = `public_${ip}`;

  if (!requestCounts.has(key)) {
    requestCounts.set(key, {
      count: 1,
      resetTime: now + RATE_LIMIT_WINDOW,
    });
    return next();
  }

  const record = requestCounts.get(key);

  if (now > record.resetTime) {
    record.count = 1;
    record.resetTime = now + RATE_LIMIT_WINDOW;
    return next();
  }

  if (record.count >= MAX_REQUESTS) {
    return res.status(429).json(
      generateResponse(
        "error",
        "Too many requests. Please try again later.",
        null,
        null
      )
    );
  }

  record.count++;
  next();
};



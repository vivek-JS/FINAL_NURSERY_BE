import { rateLimit } from "express-rate-limit";

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  limit: 100, // Limit each IP to 100 requests per `window` (here, per 15 minutes).
  standardHeaders: "draft-8",
  legacyHeaders: false, // Disable the `X-RateLimit-*` headers.
  message:
    "Too many request from this IP Address. Please try again later after 15 min", // Message to give if it exceeds limit that we set
});

export default limiter;

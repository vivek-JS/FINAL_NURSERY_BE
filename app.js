import express from "express";
import cors from "cors";
const server = express();
import cookieParser from "cookie-parser";
import errorRouter from "./controllers/error.controller.js";
import mongoSanitize from "express-mongo-sanitize";
import { xss } from "express-xss-sanitizer";
import helmet from "helmet";
import IPWhiteListing from "./middlewares/ipWhiteListing.middleware.js";
import limiter from "./middlewares/rateLimiter.middleware.js";
import parameterWhiteListing from "./middlewares/parameterWhiteListing.middleware.js";

// Security middlewares
server.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "https:"],
      connectSrc: ["'self'"],
      fontSrc: ["'self'", "data:"],
      objectSrc: ["'none'"],
      mediaSrc: ["'self'"],
      frameSrc: ["'none'"],
    },
  },
  hsts: {
    maxAge: 31536000,
    includeSubDomains: true,
    preload: true
  }
}));

// CORS configuration
const corsOptions = {
  origin: process.env.ALLOWED_ORIGINS?.split(',') || ['http://localhost:3000', 'http://localhost:3001'],
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'X-API-Version'],
  exposedHeaders: ['X-Total-Count', 'X-Page-Count']
};
server.use(cors(corsOptions));

// Body parsing middlewares
server.use(express.json({ limit: '10mb' }));
server.use(express.urlencoded({ extended: true, limit: '10mb' }));
server.use(cookieParser());

// Security middlewares
server.use(mongoSanitize());
server.use(xss());

// Rate limiting for all API routes
server.use("/api", limiter);

// IP whitelisting (uncomment if needed)
// server.use(IPWhiteListing);

// Parameter whitelisting
server.use(parameterWhiteListing);

// importing routes
import farmerRoute from "./routes/farmer.route.js";
import orderRoute from "./routes/order.route.js";
import userRoute from "./routes/user.route.js";
import cmsRoute from "./routes/cms.route.js";
import employeeRoute from "./routes/employee.route.js";
import attendanceRoute from "./routes/attendance.route.js";
import reportingRoute from "./routes/reporting.route.js";
import labRoute from "./routes/lab.route.js";
import primaryHardeingRoute from "./routes/primaryHardening.route.js";
import secondaryHardeingRoute from "./routes/secondaryHardening.route.js";
import godownRoute from "./routes/godown.route.js";
import seedRoute from "./routes/seed.route.js";
import vegetableRoute from "./routes/vegetable.route.js";
import chemicalRoute from "./routes/chemical.route.js";
import distrctRoutes from "./routes/districts.route.js";
import slotRouter from "./routes/slots.route.js";
import plantCmsRouter from "./routes/plantCms.route.js";
import vheicleRouter from "./routes/vheicle.route.js";
import shadeRoter from "./routes/shades.route.js";
import trayRouter from "./routes/tray.route.js";
import dispatchRoute from "./routes/dispatched.route.js";
import msgRoute from "./routes/msg.route.js";
import backupRoute from "./routes/backup.route.js";
import batchRoute from "./routes/batch.route.js";
import plantOutward from "./routes/plantOutward.route.js";
import PollyHouse from "./routes/pollyhouse.route.js";
import DelaerRoutes from "./routes/dealer.route.js";
import { authenticateToken } from "./middlewares/auth.middleware.js";
import ExcelRoute from "./routes/excel.route.js";

// Health check routes (no authentication required)
import healthRoute from "./routes/health.route.js";
server.use("/health", healthRoute);

// dummy route
server.get("/api/dummyData", (req, res) => {
  res.json({ msg: "Welcome to nursery app" });
});

// defining routes
server.use("/api/v1/user", userRoute);

// Protected routes - require authentication
server.use("/api/v1/farmer", limiter, authenticateToken, farmerRoute);
server.use("/api/v1/order", authenticateToken, orderRoute);
server.use("/api/v1/cms", authenticateToken, cmsRoute);
server.use("/api/v1/employee", authenticateToken, employeeRoute);
server.use("/api/v1/attendance", authenticateToken, attendanceRoute);
server.use("/api/v1/reporting", authenticateToken, reportingRoute);
server.use("/api/v1/lab", authenticateToken, labRoute);
server.use("/api/v1/primaryHardeingRoute", authenticateToken, primaryHardeingRoute);
server.use("/api/v1/secondaryHardeingRoute", authenticateToken, secondaryHardeingRoute);
server.use("/api/v1/godown", authenticateToken, godownRoute);
server.use("/api/v1/seed", authenticateToken, seedRoute);
server.use("/api/v1/vegetable", authenticateToken, vegetableRoute);
server.use("/api/v1/chemical", authenticateToken, chemicalRoute);
server.use("/api/v1/location", authenticateToken, distrctRoutes);
server.use("/api/v1", authenticateToken, slotRouter);
server.use("/api/v1/plantcms", authenticateToken, plantCmsRouter);
server.use("/api/v1/shade", authenticateToken, shadeRoter);
server.use("/api/v1/tray", authenticateToken, trayRouter);
server.use("/api/v1/vehicles", authenticateToken, vheicleRouter);
server.use("/api/v1/dispatched", authenticateToken, dispatchRoute);
server.use("/api/v1/msg", authenticateToken, msgRoute);
server.use("/api/v1/backup", authenticateToken, backupRoute);
server.use("/api/v1/batch", authenticateToken, batchRoute);
server.use("/api/v1/laboutward", authenticateToken, plantOutward);
server.use("/api/v1/pollyhouse", authenticateToken, PollyHouse);
server.use("/api/v1/dealer", authenticateToken, DelaerRoutes);
server.use("/api/v1/excel", authenticateToken, ExcelRoute);


server.use(errorRouter);

export default server;

import express from "express";
import cors from "cors";
const server = express();

// Trust proxy for cloud deployments (Render, Heroku, etc.)
server.set('trust proxy', 1);
import cookieParser from "cookie-parser";
import errorHandler from "./controllers/error.controller.js";
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
      connectSrc: ["'self'", "https://final-nursery-be-1.onrender.com", "http://localhost:8000"],
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

// CORS configuration - More permissive for development
const corsOptions = {
  origin: true, // Allow all origins for now - you can restrict this later
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'X-API-Version', 'Origin', 'Accept', 'sec-ch-ua', 'sec-ch-ua-mobile', 'sec-ch-ua-platform', 'User-Agent', 'Referer'],
  exposedHeaders: ['X-Total-Count', 'X-Page-Count'],
  optionsSuccessStatus: 200, // Some legacy browsers (IE11, various SmartTVs) choke on 204
  preflightContinue: false
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

// Simple test endpoint
server.get("/", (req, res) => {
  res.json({ 
    message: "Nursery Management API is running!",
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development'
  });
});

// CORS test endpoint
server.get("/cors-test", (req, res) => {
  res.json({
    message: "CORS is working!",
    origin: req.headers.origin,
    timestamp: new Date().toISOString(),
    cors: "enabled",
    allowedOrigins: process.env.ALLOWED_ORIGINS?.split(',') || ['default origins']
  });
});

// Handle CORS preflight for login endpoint specifically
server.options('/api/v1/user/login', cors(corsOptions), (req, res) => {
  res.status(200).end();
});



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


server.use(errorHandler);

export default server;

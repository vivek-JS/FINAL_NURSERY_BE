import express from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
const server = express();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Trust proxy for cloud deployments (Render, Heroku, etc.)
server.set('trust proxy', 1);
import errorHandler from "./controllers/error.controller.js";
import mongoSanitize from "express-mongo-sanitize";
import { xss } from "express-xss-sanitizer";
import helmet from "helmet";
import IPWhiteListing from "./middlewares/ipWhiteListing.middleware.js";

import parameterWhiteListing from "./middlewares/parameterWhiteListing.middleware.js";

// Security middlewares
server.use(helmet({
  contentSecurityPolicy: process.env.NODE_ENV === 'production' ? {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https:"],
      scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'"],
      imgSrc: ["'self'", "data:", "https:", "http:"],
      connectSrc: ["'self'", "https://final-nursery-be-1.onrender.com", "http://localhost:8000", "http://localhost:3000", "http://127.0.0.1:3000", "http://127.0.0.1:8000", "http://localhost:8081", "http://127.0.0.1:8081", "http://localhost:8082", "http://127.0.0.1:8082", "http://localhost:8083", "http://127.0.0.1:8083", "http://localhost:8084", "http://127.0.0.1:8084", "http://localhost:8085", "http://127.0.0.1:8085", "ws://localhost:3000", "ws://127.0.0.1:3000", "https://ram-biotek.onrender.com"],
      fontSrc: ["'self'", "data:", "https:"],
      objectSrc: ["'none'"],
      mediaSrc: ["'self'", "https:"],
      frameSrc: ["'none'"],
      workerSrc: ["'self'", "blob:"],
      manifestSrc: ["'self'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
      frameAncestors: ["'none'"],
      upgradeInsecureRequests: []
    },
  } : false, // Disable CSP in development
  hsts: {
    maxAge: 31536000,
    includeSubDomains: true,
    preload: true
  },
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: { policy: "cross-origin" },
  crossOriginOpenerPolicy: false // Disable COOP completely for API
}));

const normalizeOrigin = (origin) => origin?.trim().replace(/\/+$/, '');

const staticFallbackOrigins = [
  'http://localhost:3000',
  'http://localhost:3001',
  'http://localhost:3002',
  'http://localhost:3003',
  'http://127.0.0.1:3000',
  'http://127.0.0.1:3001',
  'http://127.0.0.1:3002',
  'http://127.0.0.1:3003',
  'http://localhost:8000',
  'http://127.0.0.1:8000',
  'http://localhost:8081',
  'http://127.0.0.1:8081',
  'http://localhost:8082',
  'http://127.0.0.1:8082',
  'http://localhost:8083',
  'http://127.0.0.1:8083',
  'http://localhost:8084',
  'http://127.0.0.1:8084',
  'http://localhost:8085',
  'http://127.0.0.1:8085',
  'exp://localhost:8081',
  'exp://127.0.0.1:8081',
  // Production web app (browser Origin must match; explicit list avoids deploy drift)
  'https://erp.rambiotechplants.com',
  'https://www.rambiotechplants.com',
  'https://rambiotechplants.com',
].map(normalizeOrigin);

const dynamicEnvOrigins = [
  process.env.ALLOWED_ORIGINS,
  process.env.EXTRA_ALLOWED_ORIGINS,
  process.env.CORS_ORIGINS,
  process.env.FRONTEND_URL,
  process.env.FRONTEND_URLS,
  process.env.CLIENT_URL,
  process.env.DASHBOARD_URL,
  process.env.MOBILE_APP_URL,
]
  .filter(Boolean)
  .flatMap((value) => value.split(','))
  .map(normalizeOrigin)
  .filter(Boolean);

const renderExternalUrl = normalizeOrigin(process.env.RENDER_EXTERNAL_URL);
const renderServiceUrl = normalizeOrigin(process.env.SERVICE_URL);

const allowedOriginSet = new Set([
  ...staticFallbackOrigins,
  ...dynamicEnvOrigins,
  renderExternalUrl,
  renderServiceUrl
].filter(Boolean));

/** Production browser origins that match these regexes are allowed (see also ALLOWED_ORIGINS env). */
const allowedOriginPatterns = [
  /^https:\/\/.*\.onrender\.com$/,
  /^https:\/\/.*\.vercel\.app$/,
  /^https:\/\/.*\.netlify\.app$/,
  /^https:\/\/.*\.pages\.dev$/,
  // Apex + any subdomain (frontend often on www or app — apex did not match old .*\.domain rule)
  /^https:\/\/([a-zA-Z0-9-]+\.)*rambiotechplants\.com$/,
];

const resolvedAllowedOrigins = Array.from(allowedOriginSet);

// CORS configuration - More permissive for development and mobile apps
const corsOptions = {
  origin: function (origin, callback) {
    if (!origin) return callback(null, true);

    const normalizedOrigin = normalizeOrigin(origin);

    if (process.env.NODE_ENV === 'development' || !process.env.NODE_ENV) {
      return callback(null, true);
    }

    if (
      resolvedAllowedOrigins.includes(normalizedOrigin) ||
      allowedOriginPatterns.some((pattern) => pattern.test(normalizedOrigin))
    ) {
      return callback(null, true);
    }

    // Allow same-host requests when API and frontend share the domain
    if (renderExternalUrl && normalizedOrigin === renderExternalUrl) {
      return callback(null, true);
    }

    console.warn(
      `[CORS] Blocked origin: ${normalizedOrigin}. Set ALLOWED_ORIGINS or EXTRA_ALLOWED_ORIGINS (comma-separated) on the API.`
    );
    callback(new Error(`Not allowed by CORS: ${normalizedOrigin}`));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  // Browsers preflight with Access-Control-Request-Headers; missing entries → CORS failure on iOS Safari / Chrome mobile.
  allowedHeaders: [
    'Content-Type',
    'Authorization',
    'X-Requested-With',
    'X-API-Version',
    'Origin',
    'Accept',
    'Accept-Language',
    'sec-ch-ua',
    'sec-ch-ua-mobile',
    'sec-ch-ua-platform',
    'User-Agent',
    'Referer',
    'Cookie',
    'Sec-Fetch-Mode',
    'Sec-Fetch-Site',
    'Sec-Fetch-Dest',
    'Sec-Fetch-Storage-Access',
    'Priority',
  ],
  exposedHeaders: ['X-Total-Count', 'X-Page-Count'],
  optionsSuccessStatus: 200,
  preflightContinue: false,
  maxAge: 24 * 60 * 60,
};
server.use(cors(corsOptions));

// Catch-all OPTIONS handler - handles preflight for ALL routes including dynamic paths
// Must be before routes; OPTIONS has no auth token so must not go through auth middleware
server.options("*", cors(corsOptions), (req, res) => {
  res.sendStatus(204);
});

// Body parsing middlewares
server.use(express.json({ limit: '10mb' }));
server.use(express.urlencoded({ extended: true, limit: '10mb' }));
// Gracefully handle invalid JSON bodies (e.g., clients sending literal 'null')
server.use((err, req, res, next) => {
  if (err && err.type === 'entity.parse.failed') {
    // Log and treat body as empty to avoid hard failures
    console.warn("Warning: Invalid JSON body received; treating as empty body.")
    req.body = {}
    return next()
  }
  return next(err)
});
// Removed: server.use(cookieParser());

// Set timeout for all requests (10 minutes)
server.use((req, res, next) => {
  req.setTimeout(600000); // 10 minutes in milliseconds
  res.setTimeout(600000); // 10 minutes in milliseconds
  next();
});

// Security middlewares
server.use(mongoSanitize());
server.use(xss());

// Rate limiting for all API routes - REMOVED

// IP whitelisting (uncomment if needed)
// server.use(IPWhiteListing);

// Global request logger - logs ALL incoming requests (for debugging)
server.use((req, res, next) => {
  // Only log API requests to reduce noise
  if (req.path.startsWith('/api/v1/whatsapp-order/webhook')) {
    console.log("\n🌐🌐🌐 INCOMING REQUEST TO WEBHOOK 🌐🌐🌐");
    console.log(`   Method: ${req.method}`);
    console.log(`   Path: ${req.path}`);
    console.log(`   Original URL: ${req.originalUrl}`);
    console.log(`   IP: ${req.ip || req.connection?.remoteAddress}`);
    console.log(`   User-Agent: ${req.headers['user-agent'] || 'N/A'}`);
    console.log(`   Content-Type: ${req.headers['content-type'] || 'N/A'}`);
    console.log(`   Timestamp: ${new Date().toISOString()}`);
    console.log("🌐🌐🌐 PROCEEDING TO MIDDLEWARE 🌐🌐🌐\n");
  }
  next();
});

// Parameter whitelisting
server.use(parameterWhiteListing);

// Remove problematic headers for better DevTools display
server.use('/api', (req, res, next) => {
  res.removeHeader('Cross-Origin-Opener-Policy');
  res.removeHeader('Cross-Origin-Resource-Policy');
  next();
});

// Simple test endpoint
server.get("/", (req, res) => {
  res.json({ 
    message: "Nursery Management API is running!",
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development'
  });
});

// Browser test endpoint - minimal response
server.get("/test", (req, res) => {
  res.json({ 
    success: true,
    message: "API accessible from browser",
    timestamp: new Date().toISOString()
  });
});

// CORS test endpoint
server.get("/cors-test", (req, res) => {
  res.json({
    message: "CORS is working!",
    origin: req.headers.origin,
    timestamp: new Date().toISOString(),
    cors: "enabled",
    allowedOrigins: resolvedAllowedOrigins,
    allowedOriginPatterns: allowedOriginPatterns.map((pattern) => pattern.toString())
  });
});

// Handle CORS preflight for login endpoint specifically
server.options('/api/v1/user/login', cors(corsOptions), (req, res) => {
  res.status(200).end();
});

// Handle CORS preflight for wallet-details (dynamic :dealerId - some proxies need explicit OPTIONS)
server.options('/api/v1/user/wallet-details/:dealerId', cors(corsOptions), (req, res) => {
  res.status(200).end();
});

// Handle CORS preflight for public-links endpoints (completely public, no auth)
server.options('/api/v1/public-links/config/:slug', cors(corsOptions), (req, res) => {
  res.status(200).end();
});

server.options('/api/v1/public-links/leads', cors(corsOptions), (req, res) => {
  res.status(200).end();
});

// Handle CORS preflight for opt-in webhook endpoint (public, no auth)
server.options('/api/v1/opt-in/webhook', cors(corsOptions), (req, res) => {
  res.status(200).end();
});

// importing routes
import farmerRoute from "./routes/farmer.route.js";
import farmerListRoute from "./routes/farmerList.route.js";
import whatsappContactListRoute from "./routes/whatsappContactList.route.js";
import watiProxyRoute from "./routes/watiProxy.route.js";
import exotelRoute from "./routes/exotel.route.js";
import orderRoute from "./routes/order.route.js";
import orderEventsRoute from "./modules/orderEvents/routes/orderEvents.route.js";
import financeRoute from "./modules/finance/routes/finance.route.js";
import {
  handleQRPaymentCallback,
  getFarmerOrdersDashboardTabCounts,
  getAdminDashboardStats,
  getAdminDailyMis,
  getAdminSalesMis,
  getAdminDealerMis,
  getAdminDueMis,
  getCentralReportCatalog,
  getCentralReportById,
  getAdminMisOrders,
} from "./controllers/order.controller.js";
import { getFarmerPlantLedger, getFarmerPlantLedgerParties } from "./controllers/farmerPlantOrderLedger.controller.js";
import { getRamAgriLedgerParties } from "./controllers/ramAgriLedger.controller.js";
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
import vehicleOwnerRouter from "./routes/vehicleOwner.route.js";
import vehicleDriverRouter from "./routes/vehicleDriver.route.js";
import nurserySiteRouter from "./routes/nurserySite.route.js";
import tripRouter from "./routes/trip.route.js";
import shadeRoter from "./routes/shades.route.js";
import trayRouter from "./routes/tray.route.js";
import dispatchRoute from "./routes/dispatched.route.js";
import {
  getDeliveryChallanInvoiceSequence,
  putDeliveryChallanInvoiceSequence,
} from "./controllers/invoiceSequence.controller.js";
import msgRoute from "./routes/msg.route.js";
import batchRoute from "./routes/batch.route.js";
import plantOutward from "./routes/plantOutward.route.js";
import {
  getPrimaryInwardLinesPaginated,
  getSecondaryOrdersReadyForDispatch,
  getSecondaryVehicleDispatches,
  getVehicleDispatchAllocationSuggestions,
  getFarmerDispatchPickupBatchSuggestions,
  recordSecondaryPrimaryOutwardMortality,
  markSecondaryPrimaryOutwardSowingComplete,
  patchSecondaryInwardReadinessBypass,
} from "./controllers/plantOutward.controller.js";
import PollyHouse from "./routes/pollyhouse.route.js";
import DelaerRoutes from "./routes/dealer.route.js";
import {
  authenticateToken,
  optionalAuth,
  requirePaymentAccess,
  restrictRamAgriSalesManager,
  authorizeRoles,
} from "./middlewares/auth.middleware.js";
import generateResponse from "./utility/responseFormat.js";
import ExcelRoute from "./routes/excel.route.js";
import pricingRoute from "./routes/pricing.route.js";
import analyticsRoute from "./routes/analytics.route.js";
import insightsRoute from "./routes/insights.route.js";
import { getLciSnapshot } from "./controllers/analytics.controller.js";
import oldSalesRoute from "./routes/oldSales.route.js";
import stateRoute from "./routes/state.route.js";
import locationRoute from "./routes/location.route.js";
import notificationRoute from "./routes/notification.route.js";
import whatsappOrderBotRoute from "./routes/whatsappOrderBot.route.js";
import optInWebhookRoute from "./routes/optInWebhook.route.js";
import whatsappStatusWebhookRoute from "./routes/whatsappStatusWebhook.route.js";
import sowingRoute from "./routes/sowing.route.js";
import publicFarmerLinkRoute from "./routes/publicFarmerLink.route.js";
import clearDataRoute from "./routes/clearData.route.js";
import backupRoute from "./routes/backup.route.js";
import whatsappBroadcastRoute from "./routes/whatsappBroadcast.route.js";
import iciciPaymentRoute from "./routes/icici.routes.js";
import paymentReconciliationRoute from "./routes/payment.routes.js";
import bankingRoute from "./modules/banking/routes/banking.routes.js";
import whatsappAlertRoute from "./routes/whatsappAlert.route.js";

// Inventory Management Routes
import productRoute from "./routes/product.route.js";
import supplierRoute from "./routes/supplier.route.js";
import merchantRoute from "./routes/merchant.route.js";
import measurementUnitRoute from "./routes/measurementUnit.route.js";
import categoryRoute from "./routes/category.route.js";
import purchaseOrderRoute from "./routes/purchaseOrder.route.js";
import grnRoute from "./routes/grn.route.js";
import inventoryOutwardRoute from "./routes/inventoryOutward.route.js";
import inventoryTransactionRoute from "./routes/inventoryTransaction.route.js";
import inventoryRoute from "./routes/inventory.route.js";
import purchaseRoute from "./routes/purchase.route.js";
import sellOrderRoute from "./routes/sellOrder.route.js";
import returnRequestRoute from "./routes/returnRequest.route.js";
import agriSalesOrderRoute from "./routes/agriSalesOrder.route.js";
import motivationalQuoteRoute from "./routes/motivationalQuote.route.js";
import agriLoadLinkRoute from "./routes/agriLoadLink.route.js";
import rateChangeRequestRoute from "./routes/rateChangeRequest.route.js";
import commissionRoute from "./routes/commission.route.js";
import followupMetricsRoute from "./routes/followupMetrics.route.js";
import taskRoute from "./routes/task.route.js";
import plantProductMappingRoute from "./routes/plantProductMapping.route.js";
import mapsRoute from "./routes/maps.route.js";
import callAssignmentRoute from "./routes/callAssignment.route.js";
import callListPublicRoute from "./routes/callListPublic.route.js";
import voiceFeedbackRoute from "./routes/voiceFeedback.route.js";
import readyDispatchGroupRoute from "./routes/readyDispatchGroup.route.js";
import itarKharchRoute from "./routes/itarKharch.route.js";
import {
  suggestReadyDispatchGroups,
  createReadyDispatchGroups,
  getReadyDispatchGroups,
  updateReadyDispatchGroup,
  convertReadyDispatchGroupToDispatch,
} from "./controllers/readyDispatchGroup.controller.js";

// Health check routes (no authentication required)
import healthRoute from "./routes/health.route.js";
import ocrRoute from "./routes/ocr.routes.js";
server.use("/health", healthRoute);

// UPI receipt OCR (Gemini) — multipart image; no URL storage
// Mount under /api/v1/ocr so it matches the same prefix as other APIs (proxies, env REACT_APP_BASE_URL).
server.use("/api/v1/ocr", ocrRoute);
server.use("/api/ocr", ocrRoute);

// Accountant: ledger directory lists (mounted early so nothing shadows these paths)
const farmerPlantLedgerPartiesRouter = express.Router();
farmerPlantLedgerPartiesRouter.get("/", requirePaymentAccess, getFarmerPlantLedgerParties);
server.use(
  "/api/v1/order/farmer-plant-ledger/parties",
  authenticateToken,
  farmerPlantLedgerPartiesRouter
);
const ramAgriLedgerPartiesRouter = express.Router();
ramAgriLedgerPartiesRouter.get("/", requirePaymentAccess, getRamAgriLedgerParties);
server.use(
  "/api/v1/inventory/ram-agri-customer-ledger/parties",
  authenticateToken,
  ramAgriLedgerPartiesRouter
);

// dummy route
server.get("/api/dummyData", (req, res) => {
  res.json({ msg: "Welcome to nursery app" });
});

// defining routes
server.use("/api/v1/user", userRoute);

// ============================================
// PUBLIC ROUTES - Must be BEFORE protected routes to avoid auth interception
// ============================================
server.use("/api/v1/public-links", publicFarmerLinkRoute); // Public farmer lead links (mixed auth & public)
server.use("/api/v1/location", locationRoute); // No authentication required for location APIs
server.use("/api/v1/excel", ExcelRoute); // Excel routes (download endpoint is public, others require auth)
server.use("/api/v1/whatsapp-order", whatsappOrderBotRoute); // WhatsApp order bot (webhook is public, start requires auth)
server.use("/api/v1/opt-in", optInWebhookRoute); // Opt-in/opt-out webhook + today's booking PDF report (same POST URL)
// WATI status webhook (templateMessageSent_v2, delivered, read, failed)
server.use("/api/v1/whatsapp-status", whatsappStatusWebhookRoute);
server.use("/api/v1/motivational-quote", motivationalQuoteRoute); // Motivational quotes (today endpoint is public)
server.use("/api/v1/agri-load-link", agriLoadLinkRoute); // Public one-click agri load link
server.use("/api/v1/rate-change-requests", authenticateToken, rateChangeRequestRoute); // Rate change approval flow (by-token + approve-via-link are in publicPaths)
server.use("/api/v1/commission", commissionRoute);
server.use("/api/v1/call-list", callListPublicRoute); // Public call list (token-based, no auth)
server.use("/api/v1/voice-feedback", voiceFeedbackRoute); // Post-dispatch Marathi feedback (Exotel webhook public; admin routes JWT)
server.use("/api/v1/tasks", taskRoute); // Task routes (require authentication)
server.use("/api/v1/whatsapp-broadcast", whatsappBroadcastRoute);

// Protected routes - require authentication
// Exact GET /api/v1/farmer/get (no :id) — must be before farmer router mount so it is not swallowed by 404
server.get("/api/v1/farmer/get", authenticateToken, (req, res) => {
  return res.status(400).json(
    generateResponse(
      "Fail",
      "Farmer id is required in the path. Use GET /api/v1/farmer/get/:id where :id is the farmer MongoDB _id (24 hex characters). Example: /api/v1/farmer/get/507f1f77bcf86cd799439011",
      null,
      null
    )
  );
});
server.use("/api/v1/farmer", authenticateToken, farmerRoute);
server.use("/api/v1/farmer-list", authenticateToken, farmerListRoute);
server.use("/api/v1/call-assignment", callAssignmentRoute);
server.use("/api/v1/whatsapp-contact-list", authenticateToken, whatsappContactListRoute);
server.use("/api/v1/wati", watiProxyRoute);
// Follow-up metrics (employee performance)
server.use("/api/v1/assignments", authenticateToken, followupMetricsRoute);
server.use("/api/v1/exotel", exotelRoute);
server.post("/api/v1/order/payment/qr-callback", handleQRPaymentCallback);
// ICICI EazyPay — dynamic QR, statement, status (JWT required; not under /api/v1)
server.use("/api/payments/icici", authenticateToken, iciciPaymentRoute);
// ERP payment reconciliation (accountant / super admin on sensitive routes)
server.use("/api/payments", authenticateToken, paymentReconciliationRoute);
// ICICI Corporate API — registration, statement, balance, enhanced reconciliation
server.use("/api/banking", authenticateToken, bankingRoute);
// Registered here (before order router) so GET /farmer-plant-ledger always resolves — mirrors order.route.js
server.get("/api/v1/order/farmer-plant-ledger", authenticateToken, getFarmerPlantLedger);
// Farmer dashboard tab totals — bound on app so stale order.route.js mounts never yield Cannot GET.
server.get(
  "/api/v1/order/dashboard-tab-counts",
  authenticateToken,
  getFarmerOrdersDashboardTabCounts
);
// Admin stats dashboard — bound on app for reliability.
server.get(
  "/api/v1/order/admin-dashboard-stats",
  authenticateToken,
  getAdminDashboardStats
);
server.get(
  "/api/v1/order/admin-daily-mis",
  authenticateToken,
  authorizeRoles(["ADMIN", "SUPER_ADMIN", "SUPERADMIN"]),
  getAdminDailyMis
);
server.get(
  "/api/v1/order/admin-mis-sales",
  authenticateToken,
  authorizeRoles(["ADMIN", "SUPER_ADMIN", "SUPERADMIN"]),
  getAdminSalesMis
);
server.get(
  "/api/v1/order/admin-mis-dealer",
  authenticateToken,
  authorizeRoles(["ADMIN", "SUPER_ADMIN", "SUPERADMIN"]),
  getAdminDealerMis
);
server.get(
  "/api/v1/order/admin-mis-due",
  authenticateToken,
  authorizeRoles(["ADMIN", "SUPER_ADMIN", "SUPERADMIN"]),
  getAdminDueMis
);
server.get(
  "/api/v1/order/central-report",
  authenticateToken,
  authorizeRoles(["ADMIN", "SUPER_ADMIN", "SUPERADMIN"]),
  getCentralReportCatalog
);
server.get(
  "/api/v1/order/central-report/:reportId",
  authenticateToken,
  authorizeRoles(["ADMIN", "SUPER_ADMIN", "SUPERADMIN"]),
  getCentralReportById
);
server.get(
  "/api/v1/order/admin-mis-orders",
  authenticateToken,
  authorizeRoles(["ADMIN", "SUPER_ADMIN", "SUPERADMIN"]),
  getAdminMisOrders
);
server.use("/api/v1/order", authenticateToken, orderRoute);
server.use("/api/v1/order-events", authenticateToken, orderEventsRoute);
// Direct bindings for reliability in environments with stale router mounts.
server.get("/api/v1/ready-dispatch-groups", authenticateToken, getReadyDispatchGroups);
server.post("/api/v1/ready-dispatch-groups", authenticateToken, createReadyDispatchGroups);
server.post("/api/v1/ready-dispatch-groups/suggest", authenticateToken, suggestReadyDispatchGroups);
server.patch("/api/v1/ready-dispatch-groups/:id", authenticateToken, updateReadyDispatchGroup);
server.post(
  "/api/v1/ready-dispatch-groups/:id/convert-to-dispatch",
  authenticateToken,
  convertReadyDispatchGroupToDispatch
);
server.use("/api/v1/ready-dispatch-groups", authenticateToken, readyDispatchGroupRoute);
server.use("/api/v1/cms", authenticateToken, cmsRoute);
server.use("/api/v1/itar-kharch", authenticateToken, itarKharchRoute);
const employeeAuthMiddleware =
  process.env.DISABLE_EMPLOYEE_AUTH === "true" ? optionalAuth : authenticateToken;

if (process.env.DISABLE_EMPLOYEE_AUTH === "true") {
  console.warn("⚠️  Employee authentication disabled. Remember to re-enable after testing.");
}

server.use("/api/v1/employee", employeeAuthMiddleware, employeeRoute);
server.use("/api/v1/attendance", authenticateToken, attendanceRoute);
server.use("/api/v1/reporting", authenticateToken, reportingRoute);
server.use("/api/v1/lab", authenticateToken, labRoute);
server.use("/api/v1/primaryHardeingRoute", authenticateToken, primaryHardeingRoute);
server.use("/api/v1/secondaryHardeingRoute", authenticateToken, secondaryHardeingRoute);
server.use("/api/v1/godown", authenticateToken, godownRoute);
server.use("/api/v1/seed", authenticateToken, seedRoute);
server.use("/api/v1/vegetable", authenticateToken, vegetableRoute);
server.use("/api/v1/chemical", authenticateToken, chemicalRoute);
server.use("/api/v1/districts", authenticateToken, distrctRoutes);
// Analytics before slot API. Explicit /lci so it always resolves even if router order changes.
server.get("/api/v1/analytics/lci", authenticateToken, getLciSnapshot);
server.use("/api/v1/analytics", authenticateToken, analyticsRoute);
server.use("/api/v1/insights", authenticateToken, insightsRoute);
// Slots router was mounted at `/api/v1`, which shadowed unrelated paths (e.g. /analytics). Only forward slot APIs.
function slotRouterGate(req, res, next) {
  const pathname = (req.originalUrl || "").split("?")[0] || "";
  if (
    /^\/api\/v1\/slots(\/|$)/.test(pathname) ||
    /^\/api\/v1\/salesmen-access(\/|$)/.test(pathname) ||
    /^\/api\/v1\/slot-trail(\/|$)/.test(pathname)
  ) {
    return slotRouter(req, res, next);
  }
  return next();
}
server.use("/api/v1", authenticateToken, slotRouterGate);
server.use("/api/v1/plantcms", authenticateToken, plantCmsRouter);
server.use("/api/v1/shade", authenticateToken, shadeRoter);
server.use("/api/v1/tray", authenticateToken, trayRouter);
server.use("/api/v1/vehicles", authenticateToken, vheicleRouter);
server.use("/api/v1/vehicle-owners", authenticateToken, vehicleOwnerRouter);
server.use("/api/v1/vehicle-drivers", authenticateToken, vehicleDriverRouter);
server.use("/api/v1/nursery-sites", authenticateToken, nurserySiteRouter);
server.use("/api/v1/trips", authenticateToken, tripRouter);
server.use("/api/v1/dispatched", authenticateToken, dispatchRoute);
/** Explicit bindings — same pattern as dashboard-tab-counts / laboutward (always resolves). */
server.get("/api/v1/invoice-sequence", authenticateToken, getDeliveryChallanInvoiceSequence);
server.put(
  "/api/v1/invoice-sequence",
  authenticateToken,
  authorizeRoles(["SUPER_ADMIN", "ADMIN", "ACCOUNTANT"]),
  putDeliveryChallanInvoiceSequence
);
server.use("/api/v1/msg", authenticateToken, msgRoute);
server.use("/api/v1/maps", mapsRoute); // Maps API proxy (requires auth)
server.use("/api/v1/batch", authenticateToken, batchRoute);
// Bound on app so GET always resolves (same pattern as ready-dispatch-groups / farmer-plant-ledger).
server.get(
  "/api/v1/laboutward/primary-inward-lines",
  authenticateToken,
  getPrimaryInwardLinesPaginated
);
/** Explicit POSTs so secondary mortality / sowing-complete always resolve (same handlers as plantOutward.route). */
server.post(
  "/api/v1/laboutward/secondary/primary-outward/:batchId/:primaryOutwardId/mortality",
  authenticateToken,
  recordSecondaryPrimaryOutwardMortality
);
server.post(
  "/api/v1/laboutward/secondary/primary-outward/:batchId/:primaryOutwardId/sowing-complete",
  authenticateToken,
  markSecondaryPrimaryOutwardSowingComplete
);
server.patch(
  "/api/v1/laboutward/secondary/:batchId/secondary-inward/:secondaryInwardId/readiness-bypass",
  authenticateToken,
  patchSecondaryInwardReadinessBypass
);
/** Static paths before :batchId routes — avoids param routes swallowing fixed segments on some proxies. */
server.get(
  "/api/v1/laboutward/secondary/vehicle-dispatches",
  authenticateToken,
  getSecondaryVehicleDispatches
);
server.get(
  "/api/v1/laboutward/secondary/vehicle-dispatch/:dispatchId/allocation-suggestions",
  authenticateToken,
  getVehicleDispatchAllocationSuggestions
);
server.get(
  "/api/v1/laboutward/secondary/farmer-dispatch/pickup-batch-suggestions",
  authenticateToken,
  getFarmerDispatchPickupBatchSuggestions
);
/** Explicit GET — same pattern as readiness-bypass (always resolves on nested laboutward paths). */
server.get(
  "/api/v1/laboutward/secondary/:batchId/orders-ready-for-dispatch",
  authenticateToken,
  getSecondaryOrdersReadyForDispatch
);
server.use("/api/v1/laboutward", authenticateToken, plantOutward);
server.use("/api/v1/pollyhouse", authenticateToken, PollyHouse);
server.use("/api/v1/dealer", authenticateToken, DelaerRoutes);
// Excel route moved to PUBLIC ROUTES section above (download endpoint needs to be public)
server.use("/api/v1/pricing", authenticateToken, pricingRoute);
server.use("/api/v1/old-sales", authenticateToken, oldSalesRoute);
server.use("/api/v1/state", authenticateToken, stateRoute);
server.use("/api/v1/notifications", notificationRoute); // Notification routes (has built-in auth)
server.use("/api/v1/sowing", authenticateToken, sowingRoute); // Sowing management routes
server.use("/api/v1/clear-data", authenticateToken, clearDataRoute); // Data clearing routes
server.use("/api/v1/backup", authenticateToken, backupRoute); // Local database backup (SUPER_ADMIN)

// Inventory Management Routes (all require authentication)
// IMPORTANT: Mount /api/v1/inventory/products BEFORE /api/v1/inventory so list/detail/PUT/DELETE
// use product.controller (Product model). Otherwise nested inventory routes can miss GET :id.
server.use(
  "/api/v1/inventory/products",
  authenticateToken,
  restrictRamAgriSalesManager,
  productRoute
);
server.use("/api/v1/inventory/suppliers", authenticateToken, supplierRoute);
server.use("/api/v1/inventory/merchants", authenticateToken, merchantRoute);
server.use("/api/v1/inventory/units", authenticateToken, measurementUnitRoute);
server.use("/api/v1/inventory/categories", authenticateToken, categoryRoute);
server.use("/api/v1/inventory/purchase-orders", authenticateToken, purchaseOrderRoute);
server.use("/api/v1/inventory/grn", authenticateToken, grnRoute);
server.use("/api/v1/inventory/sell-orders", authenticateToken, sellOrderRoute);
server.use("/api/v1/inventory/agri-sales-orders", authenticateToken, agriSalesOrderRoute);
// Proxy compatibility: some gateways strip `/api/v1` before forwarding.
server.use("/inventory/agri-sales-orders", authenticateToken, agriSalesOrderRoute);
server.use("/api/v1/inventory/outward", authenticateToken, inventoryOutwardRoute);
server.use("/api/v1/inventory/transactions", authenticateToken, inventoryTransactionRoute);
server.use("/api/v1/inventory/return-requests", authenticateToken, returnRequestRoute);
server.use("/api/v1/inventory", authenticateToken, inventoryRoute); // General inventory route (must be last)
server.use("/api/v1/plant-product-mappings", plantProductMappingRoute); // Plant product mapping routes (has built-in auth)
server.use("/api/v1/purchase", authenticateToken, purchaseRoute);

server.use("/api/v1/finance", authenticateToken, financeRoute);

// WhatsApp internal alert routes (test endpoint + status check)
server.use("/api/v1/whatsapp-alert", authenticateToken, whatsappAlertRoute);

// Serve locally uploaded media files
server.use('/uploads', express.static(path.join(__dirname, 'uploads')));

server.use(errorHandler);

// Schedule WhatsApp alert cron jobs (daily summary at 8 PM IST)
(async () => {
  try {
    const { initAlertCronJobs } = await import("./jobs/alertCronJobs.js");
    initAlertCronJobs();
  } catch (e) {
    console.error("[WhatsApp Cron] Failed to init cron jobs:", e?.message || e);
  }
})();

(async () => {
  try {
    const { initFinanceCronJobs } = await import("./jobs/financeCronJobs.js");
    await initFinanceCronJobs();
  } catch (e) {
    console.error("[Finance] Failed to init finance cron jobs:", e?.message || e);
  }
})();

(async () => {
  try {
    const { initBankingCronJobs } = await import("./modules/banking/jobs/bankingCronJobs.js");
    initBankingCronJobs();
  } catch (e) {
    console.error("[Banking] Failed to init banking cron jobs:", e?.message || e);
  }
})();

export default server;

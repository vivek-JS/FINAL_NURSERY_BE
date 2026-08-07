import "dotenv/config";
import mongoose from "mongoose";
import server from "./app.js";
import { attachVoiceFeedbackWebSocket } from "./services/voiceFeedback/voiceBridge.ws.js";
import { warmUpFaceModels } from "./services/faceRecognition.service.js";
import {
  startWhatsAppClient,
  shutdownWhatsAppClient,
} from "./services/whatsappClient.js";

/**
 * Resolve Mongo URI for the running environment.
 * - production: PROD_MONGO_URL (preferred), then MONGO_URL / MONGODB_URI
 * - non-production: MONGO_URL, then STAGE_MONGO_URL, then MONGODB_URI
 *
 * On the prod host, set NODE_ENV=production and PROD_MONGO_URL (or a single MONGO_URL to prod).
 */
function resolveMongoUrl() {
  const isProd = process.env.NODE_ENV === "production";
  if (isProd) {
    return (
      process.env.PROD_MONGO_URL ||
      process.env.MONGO_URL ||
      process.env.MONGODB_URI ||
      ""
    );
  }
  return (
    process.env.MONGO_URL ||
    process.env.STAGE_MONGO_URL ||
    process.env.MONGODB_URI ||
    ""
  );
}

// Production-ready MongoDB connection options
const mongoOptions = {
  serverSelectionTimeoutMS: 10000, // 10 seconds timeout
  socketTimeoutMS: 45000, // 45 seconds socket timeout
  connectTimeoutMS: 10000, // 10 seconds connection timeout
  maxPoolSize: 10, // Maintain up to 10 socket connections
  minPoolSize: process.env.NODE_ENV === 'production' ? 2 : 1, // At least 2 connections in production
  retryWrites: true,
  w: 'majority',
  retryReads: true,
};

const mongoUrl = resolveMongoUrl();
if (!mongoUrl || typeof mongoUrl !== "string") {
  console.error(
    "Missing MongoDB URI. Set PROD_MONGO_URL or MONGO_URL when NODE_ENV=production; otherwise MONGO_URL or STAGE_MONGO_URL (or MONGODB_URI)."
  );
  process.exit(1);
}

mongoose
  .connect(mongoUrl, mongoOptions)
  .then(async () => {
    console.log(`✅ Connected to database: ${mongoose.connection.name}@${mongoose.connection.host}:${mongoose.connection.port}`);

    // Define plants and varieties to be inserted

    try {
      void startWhatsAppClient().catch((e) => {
        console.error("[WhatsApp] Failed to start client:", e?.message || e);
      });

      const httpServer = server.listen(process.env.PORT || 8000, '0.0.0.0', () => {
        const port = process.env.PORT || 8000;
        console.log(`Server running on port ${port}`);
        console.log(`Server accessible at:`);
        console.log(`  - http://localhost:${port} (from this machine)`);
        console.log(`  - http://10.0.2.2:${port} (from Android emulator)`);
        console.log(`Accountant ledger directory (GET, Bearer + ACCOUNTANT/SUPER_ADMIN):`);
        console.log(`  - /api/v1/order/farmer-plant-ledger/parties`);
        console.log(`  - /api/v1/inventory/ram-agri-customer-ledger/parties`);
        try {
          attachVoiceFeedbackWebSocket(httpServer);
          console.log("Voice feedback WebSocket (Exotel / tests): ws + same host path /api/v1/voice-feedback/media");
        } catch (e) {
          console.error("Voice feedback WebSocket attach failed:", e?.message || e);
        }
      });
      
      // Set server timeout (10 minutes)
      httpServer.timeout = 600000; // 10 minutes in milliseconds
      httpServer.keepAliveTimeout = 600000; // 10 minutes
      httpServer.headersTimeout = 610000; // Slightly longer than keepAliveTimeout
      
      console.log('Server timeouts configured: 10 minutes');

      // Load + JIT the face-api WASM kernels now so the first attendance of the
      // day isn't the request that pays for a multi-second cold start.
      void warmUpFaceModels();

      const gracefulShutdown = async (signal) => {
        console.log(`\n[${signal}] Graceful shutdown...`);
        try {
          await shutdownWhatsAppClient();
        } catch (e) {
          console.warn("[WhatsApp] Shutdown error:", e?.message || e);
        }
        process.exit(0);
      };
      process.on("SIGTERM", () => void gracefulShutdown("SIGTERM"));
      process.on("SIGINT", () => void gracefulShutdown("SIGINT"));
      // nodemon < 3 default; harmless if unused
      process.on("SIGUSR2", () => void gracefulShutdown("SIGUSR2"));
    } catch (error) {
      console.error("Error starting server:", error);
    }
  })
  .catch((error) => {
    console.error(`Problem while connecting to database`, error);
    const msg = String(error?.message || error);
    if (msg.includes("querySrv") || error?.code === "EREFUSED") {
      console.error(
        "Hint (DNS): SRV lookup for mongodb+srv failed. Try another network or DNS (e.g. 1.1.1.1), toggle VPN, or use Atlas “standard” connection string."
      );
    }
    if (
      error?.name === "MongoServerSelectionError" ||
      error?.name === "MongooseServerSelectionError"
    ) {
      console.error(
        "Hint (Atlas): Check Network Access allows this machine’s IP, cluster is not paused, and credentials are correct."
      );
    }
  });

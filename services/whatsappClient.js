/**
 * WhatsApp Client — singleton using whatsapp-web.js with LocalAuth.
 *
 * Session is persisted under WHATSAPP_SESSION_PATH so QR login is required
 * only once. Never delete that directory in production.
 *
 * PM2 usage:
 *   # First run (scan QR in terminal):
 *   node index.js
 *   # Production:
 *   pm2 start index.js --name erp-backend
 *   pm2 logs erp-backend
 *   pm2 restart erp-backend
 *
 * IMPORTANT: Do NOT delete the session directory — it stores the WhatsApp
 * login state. Default: /var/www/erp-whatsapp/.wwebjs_auth
 */

import pkg from "whatsapp-web.js";
import qrcode from "qrcode-terminal";

const { Client, LocalAuth } = pkg;

const SESSION_PATH =
  process.env.WHATSAPP_SESSION_PATH || "/var/www/erp-whatsapp/.wwebjs_auth";

export let isWhatsAppReady = false;
const READY_TIMEOUT_MS = Number(process.env.WHATSAPP_READY_TIMEOUT_MS || 45000);
const REINIT_BACKOFF_MS = Number(process.env.WHATSAPP_REINIT_BACKOFF_MS || 5000);
const MAX_REINIT_ATTEMPTS = Number(process.env.WHATSAPP_MAX_REINIT_ATTEMPTS || 3);
let readyWatchdog = null;
let reinitInProgress = false;
let reinitAttempts = 0;

export const client = new Client({
  authStrategy: new LocalAuth({
    clientId: "erp-alert-bot",
    dataPath: SESSION_PATH,
  }),
  puppeteer: {
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-accelerated-2d-canvas",
      "--no-first-run",
      "--no-zygote",
      "--single-process",
      "--disable-gpu",
    ],
  },
});

const clearReadyWatchdog = () => {
  if (readyWatchdog) {
    clearTimeout(readyWatchdog);
    readyWatchdog = null;
  }
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const scheduleReadyWatchdog = () => {
  clearReadyWatchdog();
  readyWatchdog = setTimeout(() => {
    if (isWhatsAppReady) return;
    console.warn(
      `⚠️  [WhatsApp] Authenticated but not ready after ${READY_TIMEOUT_MS}ms. Re-initializing...`
    );
    void safeReinitialize("ready-timeout");
  }, READY_TIMEOUT_MS);
};

async function safeReinitialize(reason = "unknown") {
  if (reinitInProgress) return;
  if (reinitAttempts >= MAX_REINIT_ATTEMPTS) {
    console.error(
      `❌ [WhatsApp] Re-initialization skipped (${reason}) — max attempts (${MAX_REINIT_ATTEMPTS}) reached.`
    );
    return;
  }

  reinitInProgress = true;
  reinitAttempts += 1;
  isWhatsAppReady = false;
  clearReadyWatchdog();

  try {
    console.warn(
      `🔁 [WhatsApp] Re-initializing client (attempt ${reinitAttempts}/${MAX_REINIT_ATTEMPTS}) due to: ${reason}`
    );
    await client.destroy().catch(() => {});
    await sleep(REINIT_BACKOFF_MS);
    await client.initialize();
  } catch (err) {
    console.error("[WhatsApp] Re-initialization failed:", err?.message || err);
  } finally {
    reinitInProgress = false;
  }
}

client.on("qr", (qr) => {
  console.log("\n📱 [WhatsApp] QR code received — scan with your phone:\n");
  qrcode.generate(qr, { small: true });
  console.log("\n⚠️  [WhatsApp] QR will not appear again after successful scan.\n");
});

client.on("authenticated", () => {
  console.log("✅ [WhatsApp] Authenticated — session saved to", SESSION_PATH);
  isWhatsAppReady = false;
  scheduleReadyWatchdog();
});

client.on("ready", () => {
  clearReadyWatchdog();
  isWhatsAppReady = true;
  reinitAttempts = 0;
  console.log("🟢 [WhatsApp] Client is ready. Alerts will now be delivered.");
});

client.on("auth_failure", (msg) => {
  clearReadyWatchdog();
  isWhatsAppReady = false;
  console.error("❌ [WhatsApp] Authentication failed:", msg);
  console.error("   Delete the session folder and restart to re-scan QR.");
});

client.on("disconnected", (reason) => {
  clearReadyWatchdog();
  isWhatsAppReady = false;
  console.warn("🔴 [WhatsApp] Client disconnected:", reason);
  console.warn("   Attempting to re-initialize...");
  // Auto-reconnect after a short delay
  setTimeout(() => {
    void safeReinitialize(`disconnected:${reason}`);
  }, REINIT_BACKOFF_MS);
});

// Initialize on module load (runs once when the server starts)
client.initialize().catch((err) => {
  console.error("[WhatsApp] Initial initialization error:", err?.message || err);
});

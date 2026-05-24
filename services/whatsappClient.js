/**
 * WhatsApp Client — singleton using whatsapp-web.js with LocalAuth.
 *
 * Session is persisted on disk (WHATSAPP_SESSION_PATH). QR scan is required only
 * once; PM2 restart should reconnect using saved files — do not delete the folder.
 *
 * Production: set absolute WHATSAPP_SESSION_PATH in .env, e.g.
 *   WHATSAPP_SESSION_PATH=/var/www/erp-whatsapp/.wwebjs_auth
 * Run PM2 with instances: 1 (see ecosystem.config.cjs).
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import pkg from "whatsapp-web.js";
import qrcode from "qrcode-terminal";

const { Client, LocalAuth } = pkg;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");
const CLIENT_ID = "erp-alert-bot";

const READY_TIMEOUT_MS = Number(process.env.WHATSAPP_READY_TIMEOUT_MS || 120000);
const REINIT_BACKOFF_MS = Number(process.env.WHATSAPP_REINIT_BACKOFF_MS || 8000);
const MAX_REINIT_ATTEMPTS = Number(process.env.WHATSAPP_MAX_REINIT_ATTEMPTS || 5);
const WEB_VERSION_REMOTE =
  process.env.WHATSAPP_WEB_VERSION_URL ||
  "https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.54.html";

export let isWhatsAppReady = false;

let client = null;
let sessionPath = null;
let initStarted = false;
let shuttingDown = false;
let readyWatchdog = null;
let reinitInProgress = false;
let reinitAttempts = 0;
let readyWatchdogExtensions = 0;
const MAX_READY_EXTENSIONS = 2;

/** Absolute session directory — reads process.env when called (after dotenv). */
export function resolveWhatsAppSessionPath() {
  const raw =
    process.env.WHATSAPP_SESSION_PATH ||
    (process.env.NODE_ENV === "production"
      ? "/var/www/erp-whatsapp/.wwebjs_auth"
      : path.join(PROJECT_ROOT, "data", "whatsapp-auth"));

  return path.isAbsolute(raw) ? raw : path.resolve(PROJECT_ROOT, raw);
}

export function getWhatsAppSessionPath() {
  return sessionPath || resolveWhatsAppSessionPath();
}

function sessionDirForClient(dataPath) {
  return path.join(dataPath, `session-${CLIENT_ID}`);
}

export function hasPersistedWhatsAppSession(dataPath = getWhatsAppSessionPath()) {
  const dir = sessionDirForClient(dataPath);
  if (!fs.existsSync(dir)) return false;
  try {
    return fs.readdirSync(dir).length > 0;
  } catch {
    return false;
  }
}

const FALLBACK_SESSION_PATH = path.join(PROJECT_ROOT, "data", "whatsapp-auth");

function canWriteSessionDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.accessSync(dir, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/** Prefer WHATSAPP_SESSION_PATH; fall back to project data/ if not writable (fixes EACCES on Mac / bad perms). */
export function resolveWritableWhatsAppSessionPath() {
  const preferred = resolveWhatsAppSessionPath();
  if (canWriteSessionDir(preferred)) return preferred;

  console.warn(
    `[WhatsApp] Cannot write session to ${preferred} — using ${FALLBACK_SESSION_PATH}`
  );
  if (canWriteSessionDir(FALLBACK_SESSION_PATH)) return FALLBACK_SESSION_PATH;

  throw new Error(
    `[WhatsApp] No writable session directory. Fix permissions on ${preferred} or set WHATSAPP_SESSION_PATH`
  );
}

export function getWhatsAppClient() {
  return client;
}

/** Phone number of the WhatsApp account linked via QR (sender). */
export function getWhatsAppLinkedPhone() {
  try {
    const wid = client?.info?.wid;
    if (!wid) return null;
    if (typeof wid === "string") return wid.split("@")[0] || null;
    return wid.user ? String(wid.user) : null;
  } catch {
    return null;
  }
}

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
    if (isWhatsAppReady || shuttingDown) return;

    if (readyWatchdogExtensions < MAX_READY_EXTENSIONS) {
      readyWatchdogExtensions += 1;
      console.warn(
        `[WhatsApp] Authenticated — still waiting for ready (${readyWatchdogExtensions}/${MAX_READY_EXTENSIONS}, ${READY_TIMEOUT_MS}ms each)...`
      );
      scheduleReadyWatchdog();
      return;
    }

    readyWatchdogExtensions = 0;
    console.warn(
      `[WhatsApp] Authenticated but not ready after extended wait. Re-initializing (session files kept)...`
    );
    void safeReinitialize("ready-timeout");
  }, READY_TIMEOUT_MS);
};

async function safeReinitialize(reason = "unknown") {
  if (reinitInProgress || shuttingDown) return;
  if (reinitAttempts >= MAX_REINIT_ATTEMPTS) {
    console.error(
      `[WhatsApp] Re-initialization skipped (${reason}) — max attempts (${MAX_REINIT_ATTEMPTS}) reached. Session files kept at ${getWhatsAppSessionPath()}`
    );
    return;
  }

  reinitInProgress = true;
  reinitAttempts += 1;
  isWhatsAppReady = false;
  clearReadyWatchdog();

  try {
    console.warn(
      `[WhatsApp] Re-initializing (attempt ${reinitAttempts}/${MAX_REINIT_ATTEMPTS}): ${reason}`
    );
    if (client) {
      await client.destroy().catch(() => {});
      client = null;
    }
    initStarted = false;
    await sleep(REINIT_BACKOFF_MS);
    if (!shuttingDown) {
      await startWhatsAppClient();
    }
  } catch (err) {
    console.error("[WhatsApp] Re-initialization failed:", err?.message || err);
  } finally {
    reinitInProgress = false;
  }
}

function attachClientHandlers(waClient) {
  waClient.on("qr", (qr) => {
    console.log("\n📱 [WhatsApp] QR code received — scan with your phone:\n");
    qrcode.generate(qr, { small: true });
    console.log("\n⚠️  [WhatsApp] Scan once; session is saved for PM2 restarts.\n");
  });

  waClient.on("authenticated", () => {
    console.log("✅ [WhatsApp] Authenticated — session saved to", getWhatsAppSessionPath());
    isWhatsAppReady = false;
    readyWatchdogExtensions = 0;
    scheduleReadyWatchdog();
  });

  waClient.on("ready", () => {
    clearReadyWatchdog();
    readyWatchdogExtensions = 0;
    isWhatsAppReady = true;
    reinitAttempts = 0;
    console.log("🟢 [WhatsApp] Client is ready. Alerts will now be delivered.");
  });

  waClient.on("auth_failure", (msg) => {
    clearReadyWatchdog();
    isWhatsAppReady = false;
    console.error("❌ [WhatsApp] Authentication failed:", msg);
    console.error(
      "   Only if this persists: stop PM2, remove session subfolder, restart and scan QR:",
      sessionDirForClient(getWhatsAppSessionPath())
    );
  });

  waClient.on("disconnected", (reason) => {
    clearReadyWatchdog();
    isWhatsAppReady = false;
    console.warn("🔴 [WhatsApp] Client disconnected:", reason);
    if (!shuttingDown) {
      setTimeout(() => {
        void safeReinitialize(`disconnected:${reason}`);
      }, REINIT_BACKOFF_MS);
    }
  });
}

function createClient(dataPath) {
  return new Client({
    authStrategy: new LocalAuth({
      clientId: CLIENT_ID,
      dataPath,
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
    webVersionCache: {
      type: "remote",
      remotePath: WEB_VERSION_REMOTE,
    },
    takeoverOnConflict: true,
    restartOnAuthFail: false,
  });
}

/**
 * Start (or reconnect) the WhatsApp client. Safe to call after dotenv is loaded.
 * Idempotent — second call is a no-op while running.
 */
export async function startWhatsAppClient() {
  if (shuttingDown) return null;
  if (client) return client;

  sessionPath = resolveWritableWhatsAppSessionPath();

  const hasSession = hasPersistedWhatsAppSession(sessionPath);
  console.log(
    `[WhatsApp] Session path: ${sessionPath} — ${
      hasSession
        ? "saved session on disk (PM2 restart should reuse, no QR)"
        : "no session yet (QR will appear in logs)"
    }`
  );

  if (initStarted && client) return client;
  initStarted = true;

  client = createClient(sessionPath);
  attachClientHandlers(client);

  try {
    await client.initialize();
  } catch (err) {
    console.error("[WhatsApp] Initial initialization error:", err?.message || err);
    initStarted = false;
    client = null;
  }

  return client;
}

/**
 * Graceful shutdown for PM2 restart/stop — closes browser without deleting LocalAuth files.
 */
export async function shutdownWhatsAppClient() {
  if (shuttingDown && !client) return;
  shuttingDown = true;
  isWhatsAppReady = false;
  clearReadyWatchdog();

  if (client) {
    try {
      console.log("[WhatsApp] Graceful shutdown (session preserved at", getWhatsAppSessionPath() + ")");
      await client.destroy();
    } catch (err) {
      console.warn("[WhatsApp] Shutdown warning:", err?.message || err);
    }
    client = null;
  }

  initStarted = false;
  shuttingDown = false;
}

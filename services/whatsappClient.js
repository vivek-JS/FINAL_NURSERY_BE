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
let lastQrPayload = null;
let lastQrAt = null;

/** Fallback dirs when WHATSAPP_SESSION_PATH was wiped but an older copy still exists on disk. */
const SESSION_FALLBACK_ROOTS = [
  path.join(PROJECT_ROOT, ".wwebjs_auth"),
  "/var/www/FINAL_NURSERY_BE/.wwebjs_auth",
];

/** Puppeteer/WhatsApp Web page died — client object is stale until reinit. */
export function isWhatsAppDetachedError(err) {
  const msg = String(err?.message || err || "");
  return /detached Frame|Target closed|Session closed|Protocol error|Execution context was destroyed|Navigating frame was detached/i.test(
    msg
  );
}

/**
 * Mark client unhealthy and schedule reinit when Chromium frame/page is gone.
 * Returns true if the error was treated as a transport failure.
 */
export function reportWhatsAppTransportFailure(err, context = "send") {
  if (!isWhatsAppDetachedError(err)) return false;
  console.error(
    `[WhatsApp] Transport dead (${context}): ${err?.message || err} — re-initializing session`
  );
  isWhatsAppReady = false;
  if (!shuttingDown) {
    void safeReinitialize(`detached:${context}`);
  }
  return true;
}

/** Wait until ready after reinit (or until timeout). */
export async function waitUntilWhatsAppReady(timeoutMs = 90000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (isWhatsAppReady && client) return true;
    await sleep(500);
  }
  return false;
}

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

function isBrowserAlreadyRunningError(err) {
  return /browser is already running/i.test(String(err?.message || err));
}

function readSingletonLockPid(sessionDir) {
  try {
    const lockPath = path.join(sessionDir, "SingletonLock");
    if (!fs.existsSync(lockPath)) return null;
    const target = fs.readlinkSync(lockPath);
    const match = String(target).match(/-(\d+)$/);
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

function isProcessAlive(pid) {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function removeSingletonArtifacts(sessionDir) {
  for (const name of ["SingletonLock", "SingletonCookie", "SingletonSocket", "DevToolsActivePort"]) {
    const filePath = path.join(sessionDir, name);
    try {
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch {
      /* ignore */
    }
  }
}

/** Nodemon restarts often leave Puppeteer Chrome + SingletonLock — blocks QR/reconnect. */
function releaseStaleWhatsAppBrowserLock(dataPath) {
  const sessionDir = sessionDirForClient(dataPath);
  if (!fs.existsSync(sessionDir)) return false;

  const pid = readSingletonLockPid(sessionDir);
  if (pid && isProcessAlive(pid)) {
    try {
      process.kill(pid, "SIGKILL");
      console.warn(`[WhatsApp] Killed stale Puppeteer Chrome (pid ${pid})`);
    } catch (err) {
      console.warn(`[WhatsApp] Could not kill pid ${pid}:`, err?.message || err);
    }
  } else if (pid) {
    console.warn(`[WhatsApp] Clearing stale SingletonLock (pid ${pid} not running)`);
  }

  removeSingletonArtifacts(sessionDir);
  return true;
}

/** Chrome profile on disk ≠ logged in; require WhatsApp IndexedDB + cookies. */
export function hasPersistedWhatsAppSession(dataPath = getWhatsAppSessionPath()) {
  const dir = sessionDirForClient(dataPath);
  if (!fs.existsSync(dir)) return false;

  const waIndexedDb = path.join(
    dir,
    "Default",
    "IndexedDB",
    "https_web.whatsapp.com_0.indexeddb.leveldb"
  );
  const cookies = path.join(dir, "Default", "Cookies");

  try {
    const hasWaDb =
      fs.existsSync(waIndexedDb) &&
      fs.readdirSync(waIndexedDb).some((f) => f.endsWith(".ldb") || f.endsWith(".log"));
    const hasCookies = fs.existsSync(cookies) && fs.statSync(cookies).size > 512;
    return hasWaDb && hasCookies;
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
    persistQrForScan(qr);
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
    lastQrPayload = null;
    void flushPendingAlertsOnReady();
    if (
      process.env.WHATSAPP_ORDER_FLOW_ENABLED === "true" &&
      process.env.DISABLE_WHATSAPP_ORDER_WEBJS !== "true"
    ) {
      console.log(
        "🟢 [WhatsApp] Order bot listening on scanned session (web.js). WATI webhook also active if not disabled."
      );
    }
    if (process.env.WHATSAPP_AGRI_LOAD_INBOUND_ENABLED !== "false") {
      console.log(
        "🟢 [WhatsApp] Agri load inbound scan active — whitelisted admins can reply LOADED or AGR-… loaded."
      );
    }

    // If Chromium tears down the page, mark unhealthy immediately (don't keep sending on dead frame).
    try {
      const page = waClient.pupPage;
      if (page && typeof page.on === "function") {
        page.on("close", () => {
          if (!isWhatsAppReady) return;
          console.warn("[WhatsApp] Browser page closed — marking not ready");
          isWhatsAppReady = false;
          if (!shuttingDown) {
            void safeReinitialize("page-close");
          }
        });
      }
    } catch {
      /* ignore */
    }
  });

  const onInboundMessage = (msg) => {
    void (async () => {
      try {
        const { handleAgriLoadInboundMessage } = await import(
          "./whatsappAgriLoadInbound.service.js"
        );
        const agriResult = await handleAgriLoadInboundMessage(msg);
        if (agriResult?.handled) return;

        const { handleWebJsInboundMessage } = await import(
          "./whatsappOrderWebInbound.js"
        );
        await handleWebJsInboundMessage(msg);
      } catch (err) {
        console.error("[WhatsApp] Inbound handler error:", err?.message || err);
      }
    })();
  };

  waClient.on("message", onInboundMessage);
  waClient.on("message_create", onInboundMessage);

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
    if (reason === "LOGOUT") {
      console.warn(
        "[WhatsApp] WhatsApp logged out — whatsapp-web.js removed session files under",
        sessionDirForClient(getWhatsAppSessionPath()),
        "(scan QR again). Common causes: linked device removed on phone, corrupt session after hard kill, or two servers using the same session."
      );
    }
    if (!shuttingDown) {
      setTimeout(() => {
        void safeReinitialize(`disconnected:${reason}`);
      }, REINIT_BACKOFF_MS);
    }
  });
}

function tryRestoreSessionFromFallback(primaryPath) {
  if (hasPersistedWhatsAppSession(primaryPath)) return false;

  for (const fallbackRoot of SESSION_FALLBACK_ROOTS) {
    if (!fallbackRoot || path.resolve(fallbackRoot) === path.resolve(primaryPath)) continue;
    if (!hasPersistedWhatsAppSession(fallbackRoot)) continue;

    const src = sessionDirForClient(fallbackRoot);
    const dest = sessionDirForClient(primaryPath);
    try {
      fs.mkdirSync(primaryPath, { recursive: true });
      if (fs.existsSync(dest)) {
        fs.rmSync(dest, { recursive: true, force: true });
      }
      fs.cpSync(src, dest, { recursive: true });
      removeSingletonArtifacts(dest);
      console.warn(`[WhatsApp] Restored logged-in session from fallback: ${fallbackRoot}`);
      return true;
    } catch (err) {
      console.error(
        `[WhatsApp] Failed to restore session from ${fallbackRoot}:`,
        err?.message || err
      );
    }
  }
  return false;
}

function persistQrForScan(qr) {
  lastQrPayload = qr;
  lastQrAt = new Date();
  try {
    const qrFile = path.join(getWhatsAppSessionPath(), "last-qr.txt");
    fs.mkdirSync(path.dirname(qrFile), { recursive: true });
    fs.writeFileSync(
      qrFile,
      `Scan at ${lastQrAt.toISOString()}\n${qr}\n`,
      "utf8"
    );
    console.log(`[WhatsApp] QR saved to ${qrFile} (also printed below)`);
  } catch (err) {
    console.warn("[WhatsApp] Could not save QR file:", err?.message || err);
  }
}

export function getWhatsAppQrStatus() {
  return {
    hasQr: Boolean(lastQrPayload),
    lastQrAt: lastQrAt?.toISOString() || null,
    qrFile: path.join(getWhatsAppSessionPath(), "last-qr.txt"),
  };
}

/** Watchdog / manual reconnect — safe to call from cron when client is not ready. */
export async function ensureWhatsAppConnected(reason = "watchdog") {
  if (shuttingDown) return { ok: false, reason: "shutting_down" };
  if (isWhatsAppReady && client) return { ok: true, reason: "already_ready" };

  reinitAttempts = 0;
  initStarted = false;
  if (client) {
    await client.destroy().catch(() => {});
    client = null;
  }

  tryRestoreSessionFromFallback(resolveWritableWhatsAppSessionPath());
  await startWhatsAppClient();
  const ready = await waitUntilWhatsAppReady(120000);
  console.log(
    `[WhatsApp] ensureWhatsAppConnected (${reason}): ${ready ? "ready" : "still not ready"}`
  );
  return { ok: ready, reason: ready ? "ready" : "timeout" };
}

async function flushPendingAlertsOnReady() {
  try {
    const { flushPendingWhatsAppAlerts } = await import("./whatsappAlertService.js");
    await flushPendingWhatsAppAlerts();
  } catch (err) {
    console.warn("[WhatsApp] Pending alert flush failed:", err?.message || err);
  }
}

function wipeSessionDir(dataPath, reason) {
  const dir = sessionDirForClient(dataPath);
  if (!fs.existsSync(dir)) return false;
  try {
    fs.rmSync(dir, { recursive: true, force: true });
    console.warn(`[WhatsApp] Removed broken session (${reason}): ${dir}`);
    return true;
  } catch (err) {
    console.error(
      `[WhatsApp] Failed to remove session dir ${dir}:`,
      err?.message || err
    );
    return false;
  }
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
        // Avoid --single-process / --no-zygote — they cause "detached Frame" crashes under load
        "--disable-dev-shm-usage",
        "--disable-accelerated-2d-canvas",
        "--no-first-run",
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

async function initializeClientOnce(dataPath) {
  client = createClient(dataPath);
  attachClientHandlers(client);
  await client.initialize();
  return client;
}

/**
 * Start (or reconnect) the WhatsApp client. Safe to call after dotenv is loaded.
 * Idempotent — second call is a no-op while running.
 */
export async function startWhatsAppClient() {
  if (shuttingDown) return null;
  if (client) return client;

  sessionPath = resolveWritableWhatsAppSessionPath();

  if (process.env.WHATSAPP_RESET_SESSION === "true") {
    wipeSessionDir(sessionPath, "WHATSAPP_RESET_SESSION=true");
  }

  releaseStaleWhatsAppBrowserLock(sessionPath);
  tryRestoreSessionFromFallback(sessionPath);

  const hasSession = hasPersistedWhatsAppSession(sessionPath);
  const chromeOnly =
    fs.existsSync(sessionDirForClient(sessionPath)) && !hasSession;

  // Do not auto-wipe — deploy restarts were deleting valid sessions. Use WHATSAPP_RESET_SESSION=true.
  if (chromeOnly) {
    console.warn(
      "[WhatsApp] Chrome profile present but login not detected — trying reconnect without wipe (set WHATSAPP_RESET_SESSION=true to force clear)"
    );
  }

  console.log(
    `[WhatsApp] Session path: ${sessionPath} — ${
      hasSession
        ? "logged-in session on disk (restart should reuse, no QR)"
        : "no valid session — QR will print in logs within ~1–2 min"
    }`
  );

  if (initStarted && client) return client;
  initStarted = true;

  try {
    await initializeClientOnce(sessionPath);
  } catch (err) {
    console.error("[WhatsApp] Initial initialization error:", err?.message || err);
    await client?.destroy?.().catch(() => {});
    client = null;

    if (isBrowserAlreadyRunningError(err)) {
      releaseStaleWhatsAppBrowserLock(sessionPath);
      await sleep(REINIT_BACKOFF_MS);
      try {
        console.warn("[WhatsApp] Retrying after clearing stale browser lock...");
        await initializeClientOnce(sessionPath);
      } catch (retryErr) {
        console.error(
          "[WhatsApp] Retry after browser lock failed:",
          retryErr?.message || retryErr
        );
        await client?.destroy?.().catch(() => {});
        client = null;
        initStarted = false;
      }
    } else if (
      isWhatsAppDetachedError(err) ||
      /Execution context was destroyed/i.test(String(err?.message || err))
    ) {
      releaseStaleWhatsAppBrowserLock(sessionPath);
      await sleep(REINIT_BACKOFF_MS);
      try {
        console.warn("[WhatsApp] Retrying initialize after protocol error (session kept)...");
        await initializeClientOnce(sessionPath);
      } catch (retryErr) {
        console.error(
          "[WhatsApp] Retry initialization failed:",
          retryErr?.message || retryErr
        );
        await client?.destroy?.().catch(() => {});
        client = null;
        initStarted = false;
      }
    } else {
      initStarted = false;
    }
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

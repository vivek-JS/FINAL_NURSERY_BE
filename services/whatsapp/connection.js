/**
 * Single Baileys linked-device socket (no browser). Login lives in MongoDB — scan once.
 *
 * Status: idle | connecting | qr | connected | reconnecting | needs_scan | logged_out | replaced | disabled
 * Events (waEvents): "ready", "status" (status), "message" (raw WAMessage), "ack" (messageId, status)
 */
import { EventEmitter } from "events";
import QRCode from "qrcode";
import makeWASocket, {
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion,
  isJidBroadcast,
  isJidGroup,
  isJidNewsletter,
  jidDecode,
  makeCacheableSignalKeyStore,
} from "baileys";
import {
  clearWhatsAppSession,
  hasStoredWhatsAppSession,
  useMongoAuthState,
} from "./mongoAuthState.js";
import {
  createWaLogger,
  getQrWindowMs,
  getWhatsAppDeviceName,
  getWhatsAppSessionId,
  isWhatsAppClientEnabled,
} from "./config.js";

export const waEvents = new EventEmitter();
waEvents.setMaxListeners(100);

export let isWhatsAppReady = false;

const state = {
  status: "idle",
  qr: null,
  qrAt: null,
  linkedPhone: null,
  linkedName: null,
  sessionSaved: false,
  lastConnectedAt: null,
  lastDisconnect: null,
};

const SENT_CACHE_MAX = 500;
const MAX_BACKOFF_MS = 60000;
/** Re-delivery cache: phones ask for resend when they fail to decrypt ("Waiting for this message"). */
const sentCache = new Map();

let sock = null;
let starting = null;
let reconnectTimer = null;
let reconnectAttempt = 0;
let shuttingDown = false;
let qrWantedUntil = 0;
let cachedVersion = null;
let pendingCredsSave = Promise.resolve();

function setStatus(status) {
  if (state.status === status) return;
  state.status = status;
  waEvents.emit("status", status);
}

function setReady(ready) {
  if (isWhatsAppReady === ready) return;
  isWhatsAppReady = ready;
  if (ready) waEvents.emit("ready");
}

export function getActiveSocket() {
  return sock;
}

export function rememberSentMessage(sent) {
  const id = sent?.key?.id;
  if (!id || !sent.message) return;
  sentCache.set(id, sent.message);
  if (sentCache.size > SENT_CACHE_MAX) sentCache.delete(sentCache.keys().next().value);
}

async function getWaVersion() {
  if (cachedVersion) return cachedVersion;
  try {
    const { version } = await fetchLatestBaileysVersion();
    cachedVersion = version;
  } catch {
    /* fall back to the version bundled with baileys */
  }
  return cachedVersion;
}

function nextBackoffMs() {
  const base = Math.min(MAX_BACKOFF_MS, 2000 * 2 ** reconnectAttempt);
  reconnectAttempt += 1;
  return base + Math.floor(Math.random() * 1000);
}

function clearReconnectTimer() {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = null;
}

function scheduleReconnect(delayMs) {
  clearReconnectTimer();
  setStatus("reconnecting");
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void startWhatsAppClient({ wantQr: false });
  }, delayMs);
}

function detachSocket() {
  const current = sock;
  sock = null;
  setReady(false);
  if (!current) return null;
  try {
    current.end(undefined);
  } catch {
    /* already closed */
  }
  return current;
}

function printQrToTerminal(qr) {
  QRCode.toString(qr, { type: "terminal", small: true })
    .then((art) => {
      console.log("\n📱 [WhatsApp] Scan with phone → WhatsApp → Linked devices → Link a device:\n");
      console.log(art);
      console.log("   (or open ERP → WhatsApp Connection)\n");
    })
    .catch(() => {});
}

function markLinked(socket) {
  const user = socket.user || {};
  state.linkedPhone = jidDecode(user.id)?.user || null;
  state.linkedName = user.name || user.verifiedName || null;
  state.sessionSaved = true;
  state.lastConnectedAt = new Date();
  state.qr = null;
  state.qrAt = null;
}

async function onConnectionClosed(lastDisconnect) {
  const code = lastDisconnect?.error?.output?.statusCode ?? null;
  const reason = lastDisconnect?.error?.message || "unknown";
  state.lastDisconnect = { code, reason, at: new Date() };
  state.qr = null;
  sock = null;
  setReady(false);
  if (shuttingDown) return;

  if (code === DisconnectReason.loggedOut || code === DisconnectReason.forbidden) {
    console.warn(`🔴 [WhatsApp] Linked device removed (${code}) — new scan required`);
    await clearWhatsAppSession(getWhatsAppSessionId()).catch(() => {});
    state.sessionSaved = false;
    state.linkedPhone = null;
    state.linkedName = null;
    setStatus("logged_out");
    if (Date.now() < qrWantedUntil) scheduleReconnect(1000);
    return;
  }

  if (code === DisconnectReason.connectionReplaced) {
    console.warn(
      "🔴 [WhatsApp] Another server opened this same session — this one stays offline (avoid ping-pong)."
    );
    setStatus("replaced");
    return;
  }

  if (!state.sessionSaved) {
    if (Date.now() < qrWantedUntil) {
      scheduleReconnect(1000);
    } else {
      setStatus("needs_scan");
    }
    return;
  }

  const delay = code === DisconnectReason.restartRequired ? 0 : nextBackoffMs();
  console.warn(`🟠 [WhatsApp] Disconnected (${code ?? "?"}: ${reason}) — reconnecting in ${delay}ms`);
  scheduleReconnect(delay);
}

async function openSocket() {
  const sessionId = getWhatsAppSessionId();
  await pendingCredsSave;
  const { state: auth, saveCreds } = await useMongoAuthState(sessionId);
  state.sessionSaved = Boolean(auth.creds?.me?.id);

  const logger = createWaLogger();
  const version = await getWaVersion();
  const socket = makeWASocket({
    ...(version ? { version } : {}),
    auth: { creds: auth.creds, keys: makeCacheableSignalKeyStore(auth.keys, logger) },
    logger,
    browser: Browsers.macOS(getWhatsAppDeviceName()),
    markOnlineOnConnect: false,
    syncFullHistory: false,
    shouldIgnoreJid: (jid) => isJidBroadcast(jid) || isJidNewsletter(jid) || isJidGroup(jid),
    getMessage: async (key) => sentCache.get(key.id),
  });
  sock = socket;
  setStatus("connecting");
  console.log(
    `[WhatsApp] Connecting session "${sessionId}" — ${
      state.sessionSaved ? "saved login found (no scan needed)" : "not linked yet (QR will show)"
    }`
  );

  socket.ev.on("creds.update", () => {
    if (auth.creds?.me?.id) state.sessionSaved = true;
    pendingCredsSave = saveCreds().catch((err) =>
      console.error("[WhatsApp] Saving creds failed:", err?.message || err)
    );
  });

  socket.ev.on("connection.update", ({ connection, lastDisconnect, qr }) => {
    if (socket !== sock) return;

    if (qr) {
      if (Date.now() > qrWantedUntil) {
        setStatus("needs_scan");
        detachSocket();
        return;
      }
      state.qr = qr;
      state.qrAt = new Date();
      setStatus("qr");
      printQrToTerminal(qr);
    }

    if (connection === "open") {
      reconnectAttempt = 0;
      markLinked(socket);
      setStatus("connected");
      setReady(true);
      console.log(`🟢 [WhatsApp] Connected as +${state.linkedPhone || "?"}`);
    } else if (connection === "close") {
      void onConnectionClosed(lastDisconnect);
    }
  });

  socket.ev.on("messages.upsert", ({ messages, type }) => {
    if (socket !== sock || type !== "notify") return;
    for (const message of messages) waEvents.emit("message", message);
  });

  socket.ev.on("messages.update", (updates) => {
    for (const { key, update } of updates) {
      if (key?.fromMe && typeof update?.status === "number") {
        waEvents.emit("ack", key.id, update.status);
      }
    }
  });

  return socket;
}

/**
 * Start (idempotent). wantQr opens the QR window so an unlinked session keeps refreshing codes.
 */
export async function startWhatsAppClient({ wantQr = true } = {}) {
  if (!isWhatsAppClientEnabled()) {
    setStatus("disabled");
    return null;
  }
  if (wantQr) qrWantedUntil = Math.max(qrWantedUntil, Date.now() + getQrWindowMs());
  shuttingDown = false;
  if (sock) return sock;
  if (starting) return starting;

  clearReconnectTimer();
  starting = openSocket()
    .catch((err) => {
      console.error("[WhatsApp] Connect failed:", err?.message || err);
      sock = null;
      scheduleReconnect(nextBackoffMs());
      return null;
    })
    .finally(() => {
      starting = null;
    });
  return starting;
}

export function waitUntilWhatsAppReady(timeoutMs = 60000) {
  if (isWhatsAppReady) return Promise.resolve(true);
  return new Promise((resolve) => {
    const onReady = () => {
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      waEvents.off("ready", onReady);
      resolve(false);
    }, timeoutMs);
    waEvents.once("ready", onReady);
  });
}

function waitForStatus(target, timeoutMs) {
  if (state.status === target) return Promise.resolve(true);
  return new Promise((resolve) => {
    const onStatus = (status) => {
      if (status !== target) return;
      clearTimeout(timer);
      waEvents.off("status", onStatus);
      resolve(true);
    };
    const timer = setTimeout(() => {
      waEvents.off("status", onStatus);
      resolve(false);
    }, timeoutMs);
    waEvents.on("status", onStatus);
  });
}

export function isWhatsAppConnectionInProgress() {
  if (isWhatsAppReady) return false;
  return (
    Boolean(starting) ||
    Boolean(reconnectTimer) ||
    ["connecting", "reconnecting", "qr"].includes(state.status)
  );
}

/** Reconnect if a saved login exists. Never opens a QR window unless wantQr/force. */
export async function ensureWhatsAppConnected(
  reason = "watchdog",
  { timeoutMs = 60000, wantQr = false, force = false } = {}
) {
  if (shuttingDown) return { ok: false, reason: "shutting_down" };
  if (isWhatsAppReady) return { ok: true, reason: "already_ready" };
  if (state.status === "replaced" && !force) return { ok: false, reason: "replaced_by_other_server" };

  if (!wantQr && !state.sessionSaved) {
    const saved = await hasStoredWhatsAppSession(getWhatsAppSessionId()).catch(() => false);
    if (!saved) return { ok: false, reason: "needs_scan" };
  }

  if (force && state.status === "replaced") setStatus("idle");
  await startWhatsAppClient({ wantQr });
  const ok = await waitUntilWhatsAppReady(timeoutMs);
  if (!ok) console.warn(`[WhatsApp] ensureWhatsAppConnected (${reason}) → ${state.status}`);
  return { ok, reason: ok ? "ready" : state.status };
}

/** Called while someone is looking at the QR (ERP page / campaign app) — keeps codes refreshing. */
export async function requestWhatsAppQr() {
  if (isWhatsAppReady) return;
  if (state.status === "replaced") setStatus("idle");
  await startWhatsAppClient({ wantQr: true });
}

/** Link with an 8-character code instead of a QR (phone → Linked devices → Link with phone number). */
export async function requestWhatsAppPairingCode(phone) {
  if (isWhatsAppReady) throw new Error("WhatsApp is already linked");
  const digits = String(phone || "").replace(/\D/g, "");
  const full = digits.length === 10 ? `91${digits}` : digits;
  if (full.length < 11) throw new Error("Enter the WhatsApp number with country code");

  await requestWhatsAppQr();
  const ready = await waitForStatus("qr", 25000);
  if (!ready || !sock) throw new Error("WhatsApp is not ready for linking yet — try again");
  const code = await sock.requestPairingCode(full);
  return String(code).match(/.{1,4}/g).join("-");
}

/** Unlink this server from the phone, wipe the stored login and show a fresh QR. */
export async function resetWhatsAppSessionForRelink(reason = "manual-reset") {
  console.warn(`[WhatsApp] Session reset (${reason}) — new scan required`);
  clearReconnectTimer();
  const current = sock;
  sock = null;
  setReady(false);
  if (current) {
    await current.logout().catch(() => {});
    try {
      current.end(undefined);
    } catch {
      /* already closed */
    }
  }
  await clearWhatsAppSession(getWhatsAppSessionId());
  Object.assign(state, { sessionSaved: false, linkedPhone: null, linkedName: null, qr: null, qrAt: null });
  setStatus("idle");
  await startWhatsAppClient({ wantQr: true });
  return { ok: true, reason: "qr_pending" };
}

/** Graceful stop for PM2/nodemon — keeps the stored login. */
export async function shutdownWhatsAppClient() {
  shuttingDown = true;
  clearReconnectTimer();
  if (detachSocket()) console.log("[WhatsApp] Socket closed (login kept in MongoDB)");
}

export function getWhatsAppLinkedPhone() {
  return state.linkedPhone;
}

export function hasSavedWhatsAppSession() {
  return state.sessionSaved;
}

export function getWhatsAppConnectionStatus({ includeQr = false } = {}) {
  return {
    status: state.status,
    whatsappReady: isWhatsAppReady,
    linkedPhone: state.linkedPhone,
    linkedName: state.linkedName,
    sessionSaved: state.sessionSaved,
    sessionId: getWhatsAppSessionId(),
    deviceName: getWhatsAppDeviceName(),
    lastConnectedAt: state.lastConnectedAt,
    lastDisconnect: state.lastDisconnect,
    qrAt: state.status === "qr" ? state.qrAt : null,
    ...(includeQr ? { qr: state.status === "qr" ? state.qr : null } : {}),
  };
}

export function isWhatsAppConnectionError(err) {
  const code = err?.output?.statusCode;
  if (code === 428 || code === 408 || code === 440) return true;
  return /Connection Closed|Connection Terminated|Timed Out|not open|socket hang up/i.test(
    String(err?.message || err)
  );
}

/** Log + classify a send failure. Reconnect itself is driven by connection.update. */
export function reportWhatsAppTransportFailure(err, context = "send") {
  if (!isWhatsAppConnectionError(err)) return false;
  console.warn(`[WhatsApp] Connection error during ${context}: ${err?.message || err}`);
  return true;
}

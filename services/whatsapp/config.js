/**
 * WhatsApp (Baileys) runtime config — read lazily so values come from .env after dotenv loads.
 *
 *   WHATSAPP_CLIENT_ENABLED=false   disable the linked-device connection on this server
 *   WHATSAPP_SESSION_ID=erp-prod    MongoDB session key (default erp-<NODE_ENV>, keeps dev off the prod link)
 *   WHATSAPP_DEVICE_NAME=Chrome     name shown under Linked devices on the phone
 *   WHATSAPP_QR_WINDOW_MS=180000    how long QR codes keep refreshing without anyone scanning
 *   WHATSAPP_LOG_LEVEL=silent       Baileys internal log level (trace|debug|info|warn|error|silent)
 */

export const isWhatsAppClientEnabled = () => process.env.WHATSAPP_CLIENT_ENABLED !== "false";

export const getWhatsAppSessionId = () =>
  process.env.WHATSAPP_SESSION_ID || `erp-${process.env.NODE_ENV || "development"}`;

export const getWhatsAppDeviceName = () => process.env.WHATSAPP_DEVICE_NAME || "Chrome";

export const getQrWindowMs = () => Number(process.env.WHATSAPP_QR_WINDOW_MS) || 180000;

const LEVELS = ["trace", "debug", "info", "warn", "error", "fatal"];
const CONSOLE_FN = { trace: "debug", debug: "debug", info: "info", warn: "warn", error: "error", fatal: "error" };
const noop = () => {};

/** Minimal pino-compatible logger for Baileys (it requires child/level/trace…fatal). */
export function createWaLogger(level = process.env.WHATSAPP_LOG_LEVEL || "silent") {
  const min = LEVELS.indexOf(level);
  const logger = { level, child: () => logger };
  LEVELS.forEach((name, i) => {
    logger[name] =
      min === -1 || i < min
        ? noop
        : (obj, msg) => console[CONSOLE_FN[name]](`[Baileys:${name}]`, msg ?? "", obj ?? "");
  });
  return logger;
}

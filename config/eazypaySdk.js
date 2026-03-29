/**
 * ICICI EazyPay SDK helpers — paths, logger, and env checks.
 * sdk-api-config.json is normally supplied by the bank; API key may also live there (keep out of git if sensitive).
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import winston from "winston";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(__dirname, "..");

/** Default: config/sdk-api-config.json next to this file */
export function getSdkConfigPath() {
  const p = process.env.EAZYPAY_SDK_CONFIG_PATH || path.join(projectRoot, "config", "sdk-api-config.json");
  return path.isAbsolute(p) ? p : path.join(projectRoot, p.replace(/^\.\//, ""));
}

export function isLoggerEnabled() {
  return String(process.env.IS_LOGGER_ENABLE || "").toLowerCase() === "true";
}

let loggerInstance;
export function getEazypayLogger() {
  if (!isLoggerEnabled()) {
    return {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    };
  }
  if (!loggerInstance) {
    loggerInstance = winston.createLogger({
      level: "info",
      format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.printf(({ level, message, timestamp, ...meta }) => {
          const rest = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : "";
          return `${timestamp} [${level}] [EazyPay] ${message}${rest}`;
        })
      ),
      transports: [new winston.transports.Console()],
    });
  }
  return loggerInstance;
}

/**
 * Resolve a path relative to project root or cwd.
 */
export function resolvePathMaybeRelative(p) {
  if (!p || typeof p !== "string") return null;
  if (path.isAbsolute(p)) return p;
  return path.join(projectRoot, p.replace(/^\.\//, ""));
}

/**
 * Ensure required files exist before calling SDK (optional soft check).
 * Throws with code for controller mapping.
 */
export function assertEazypayFilesPresent() {
  const keystore = resolvePathMaybeRelative(process.env.EAZYPAY_KEYSTORE_PATH);
  const pem = resolvePathMaybeRelative(process.env.EAZYPAY_PRIVATE_PEM_PATH);
  const configPath = getSdkConfigPath();

  const stubHint =
    " For UAT/sandbox testing without bank .jks/.pem, set EAZYPAY_USE_STUB=true in .env and restart the server.";

  if (!process.env.EAZYPAY_USE_STUB || process.env.EAZYPAY_USE_STUB !== "true") {
    if (!keystore || !fs.existsSync(keystore)) {
      const err = new Error(
        (keystore
          ? "Keystore file not found at EAZYPAY_KEYSTORE_PATH"
          : "EAZYPAY_KEYSTORE_PATH is not set") + stubHint
      );
      err.code = "EAZYPAY_KEYSTORE_ERROR";
      throw err;
    }
    if (!pem || !fs.existsSync(pem)) {
      const err = new Error(
        (pem
          ? "Private PEM not found at EAZYPAY_PRIVATE_PEM_PATH"
          : "EAZYPAY_PRIVATE_PEM_PATH is not set") + stubHint
      );
      err.code = "EAZYPAY_KEYSTORE_ERROR";
      throw err;
    }
  }

  if (!fs.existsSync(configPath)) {
    const err = new Error("sdk-api-config.json missing — copy from ICICI SDK to config/");
    err.code = "SDK_CONFIG_NOT_SUBSCRIBED";
    throw err;
  }
}

/**
 * Read sdk-api-config.json (for logging api names only — do not log secrets).
 */
export function readSdkConfigJson() {
  const raw = fs.readFileSync(getSdkConfigPath(), "utf8");
  return JSON.parse(raw);
}

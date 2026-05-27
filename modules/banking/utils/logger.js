import winston from "winston";
import { maskSensitiveObject } from "./logMasking.js";

const bankingLogger = winston.createLogger({
  level: process.env.BANKING_LOG_LEVEL || process.env.LOG_LEVEL || "info",
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.printf(({ level, message, timestamp, ...meta }) => {
      const safe = maskSensitiveObject(meta);
      const rest = Object.keys(safe).length ? ` ${JSON.stringify(safe)}` : "";
      return `${timestamp} [${level}] [Banking] ${message}${rest}`;
    })
  ),
  transports: [new winston.transports.Console()],
});

export function getBankingLogger() {
  return bankingLogger;
}

export default bankingLogger;

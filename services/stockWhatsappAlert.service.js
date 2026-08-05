/**
 * Fire-and-forget admin WhatsApp alerts for all stock changes.
 */

import {
  sendStockChangeAlert,
  sendStockInwardAlert,
  sendDailyClosingStockSummaryAlert,
} from "./whatsappAlertService.js";

function schedule(fn, payload, label) {
  void fn(payload).catch((err) =>
    console.error(`[WhatsApp Alert] ${label}:`, err?.message || err)
  );
}

/** @param {object} payload */
export function scheduleStockInwardAlert(payload) {
  if (!payload?.productName) return;
  schedule(sendStockInwardAlert, payload, "stock inward");
}

/** @param {object} payload */
export function scheduleStockChangeAlert(payload) {
  if (!payload?.productName && payload?.changeType !== "closing") return;
  schedule(sendStockChangeAlert, payload, `stock ${payload.changeType || "change"}`);
}

/** @param {object} payload */
export function scheduleDailyClosingStockAlert(payload) {
  if (!payload?.entries?.length) return;
  schedule(sendDailyClosingStockSummaryAlert, payload, "closing stock");
}

export {
  sendStockChangeAlert,
  sendStockInwardAlert,
  sendDailyClosingStockSummaryAlert,
};

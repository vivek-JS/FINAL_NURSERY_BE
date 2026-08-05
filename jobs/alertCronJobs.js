/**
 * Alert Cron Jobs — scheduled WhatsApp notifications.
 *
 * Call initAlertCronJobs() once at server startup (in index.js or app.js).
 * Requires node-cron (already installed).
 */

import cron from "node-cron";
import Order from "../models/order.model.js";
import { sendDailySummaryAlert } from "../services/whatsappAlertService.js";
import { sendAdminDailyMisMarathiAlert } from "../services/adminDailyMisWhatsapp.service.js";
import {
  runScheduledAlertEngine,
  runDailyOpsAlertEngine,
} from "../services/whatsappAlertEngine.service.js";

/**
 * Builds a daily summary by querying Orders created today.
 */
async function buildDailySummary() {
  const now = new Date();
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
  const endOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);

  const [result] = await Order.aggregate([
    {
      $match: {
        createdAt: { $gte: startOfDay, $lte: endOfDay },
        orderStatus: { $nin: ["CANCELLED", "REJECTED"] },
      },
    },
    {
      $group: {
        _id: null,
        orderCount: { $sum: 1 },
        totalRevenue: { $sum: { $multiply: ["$rate", "$numberOfPlants"] } },
        dispatches: {
          $sum: { $cond: [{ $eq: ["$orderStatus", "DISPATCHED"] }, 1, 0] },
        },
      },
    },
  ]);

  return {
    date: now.toLocaleDateString("en-IN", {
      day: "2-digit",
      month: "short",
      year: "numeric",
    }),
    orderCount: result?.orderCount ?? 0,
    totalRevenue: result?.totalRevenue ?? 0,
    dispatches: result?.dispatches ?? 0,
  };
}

/**
 * Registers all scheduled WhatsApp alert cron jobs.
 * Call this once after the DB connection is established.
 */
export function initAlertCronJobs() {
  if (process.env.WHATSAPP_ALERTS_ENABLED !== "true") {
    console.log("[WhatsApp Cron] Alerts disabled — skipping cron job registration.");
    return;
  }

  const tz = "Asia/Kolkata";

  // Admin MIS digest (Marathi) — default 7:00 PM IST
  const misCron = process.env.WHATSAPP_ADMIN_MIS_CRON || "30 13 * * *";
  cron.schedule(
    misCron,
    async () => {
      console.log("[WhatsApp Cron] Running admin daily MIS (Marathi) job...");
      try {
        const result = await sendAdminDailyMisMarathiAlert();
        console.log("[WhatsApp Cron] Admin daily MIS done:", {
          sent: result.sent,
          delivered: result.delivered,
          dateKey: result.dateKey,
          chunks: result.chunks,
        });
      } catch (err) {
        console.error("[WhatsApp Cron] Admin daily MIS job failed:", err?.message || err);
      }
    },
    { scheduled: true, timezone: tz }
  );

  // Legacy short summary at 8:00 PM IST (optional — set WHATSAPP_LEGACY_DAILY_SUMMARY=true)
  if (process.env.WHATSAPP_LEGACY_DAILY_SUMMARY === "true") {
    cron.schedule(
      "30 14 * * *",
      async () => {
        console.log("[WhatsApp Cron] Running legacy daily summary job...");
        try {
          const summary = await buildDailySummary();
          await sendDailySummaryAlert(summary);
          console.log("[WhatsApp Cron] Legacy daily summary sent.");
        } catch (err) {
          console.error("[WhatsApp Cron] Legacy daily summary job failed:", err?.message || err);
        }
      },
      { scheduled: true, timezone: tz }
    );
  }

  // Ops backlog digest — 8:00 AM IST
  const opsCron = process.env.WHATSAPP_ALERT_OPS_CRON || "0 8 * * *";
  cron.schedule(
    opsCron,
    async () => {
      console.log("[WhatsApp Cron] Running ops alert engine...");
      try {
        const result = await runDailyOpsAlertEngine();
        console.log("[WhatsApp Cron] Ops alert engine done:", result);
      } catch (err) {
        console.error("[WhatsApp Cron] Ops alert engine failed:", err?.message || err);
      }
    },
    { scheduled: true, timezone: tz }
  );

  // Slot availability scan — default 9 AM, 2 PM, 6 PM IST
  const slotCron = process.env.WHATSAPP_ALERT_SLOT_SCAN_CRON || "0 9,14,18 * * *";
  cron.schedule(
    slotCron,
    async () => {
      console.log("[WhatsApp Cron] Running slot availability alert scan...");
      try {
        const result = await runScheduledAlertEngine();
        console.log("[WhatsApp Cron] Slot scan done:", result);
      } catch (err) {
        console.error("[WhatsApp Cron] Slot scan failed:", err?.message || err);
      }
    },
    { scheduled: true, timezone: tz }
  );

  console.log(`✅ [WhatsApp Cron] Admin MIS (Marathi) @ ${misCron} (${tz}).`);
  if (process.env.WHATSAPP_LEGACY_DAILY_SUMMARY === "true") {
    console.log("✅ [WhatsApp Cron] Legacy daily summary @ 8:00 PM IST.");
  }
  console.log(`✅ [WhatsApp Cron] Ops digest @ ${opsCron} (${tz}).`);
  console.log(`✅ [WhatsApp Cron] Slot scan @ ${slotCron} (${tz}).`);
}

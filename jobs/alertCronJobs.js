/**
 * Alert Cron Jobs — scheduled WhatsApp notifications.
 *
 * Call initAlertCronJobs() once at server startup (in index.js or app.js).
 * Requires node-cron (already installed).
 */

import cron from "node-cron";
import Order from "../models/order.model.js";
import {
  isWhatsAppReady,
  isWhatsAppConnectionInProgress,
  ensureWhatsAppConnected,
} from "../services/whatsapp/index.js";
import { sendDailySummaryAlert } from "../services/whatsappAlertService.js";
import { sendAdminDailyMisMarathiAlert } from "../services/adminDailyMisWhatsapp.service.js";
import {
  sendIntradayOpsWhatsappAlert,
  sendDayEndOpsWhatsappAlert,
} from "../services/intradayOpsWhatsapp.service.js";
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

  // Intraday 2.5h ops — OFF by default (set WHATSAPP_INTRADAY_REPORT_ENABLED=true to re-enable)
  const intradayEnabled = process.env.WHATSAPP_INTRADAY_REPORT_ENABLED === "true";
  const intradayCrons = (
    process.env.WHATSAPP_INTRADAY_REPORT_CRON || "0 13 * * *;30 15 * * *;0 18 * * *;0 20 * * *"
  )
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);

  if (intradayEnabled) {
    for (const expr of intradayCrons) {
      cron.schedule(
        expr,
        async () => {
          console.log(`[WhatsApp Cron] Running intraday 2.5h ops report (${expr})...`);
          try {
            const result = await sendIntradayOpsWhatsappAlert();
            console.log("[WhatsApp Cron] Intraday ops report done:", {
              sent: result.sent,
              delivered: result.delivered,
              chunks: result.chunks,
              skipped: result.skipped,
              reason: result.reason,
            });
          } catch (err) {
            console.error("[WhatsApp Cron] Intraday ops report failed:", err?.message || err);
          }
        },
        { scheduled: true, timezone: tz }
      );
    }
  }

  // Legacy short summary (optional — set WHATSAPP_LEGACY_DAILY_SUMMARY=true)
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

  // Ops backlog digest — OFF by default (set WHATSAPP_ALERT_OPS_ENABLED=true)
  const opsEnabled = process.env.WHATSAPP_ALERT_OPS_ENABLED === "true";
  const opsCron = process.env.WHATSAPP_ALERT_OPS_CRON || "0 8 * * *";
  if (opsEnabled) {
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
  }

  // Booking capacity (FIFO) — OFF by default (set WHATSAPP_ALERT_BOOKING_CAPACITY_ENABLED=true)
  const bookingCapEnabled =
    process.env.WHATSAPP_ALERT_BOOKING_CAPACITY_ENABLED === "true";
  const slotCron = process.env.WHATSAPP_ALERT_SLOT_SCAN_CRON || "0 9,14,18 * * *";
  if (bookingCapEnabled) {
    cron.schedule(
      slotCron,
      async () => {
        console.log("[WhatsApp Cron] Running booking capacity (FIFO) digest...");
        try {
          const result = await runScheduledAlertEngine();
          console.log("[WhatsApp Cron] Booking capacity digest done:", result);
        } catch (err) {
          console.error("[WhatsApp Cron] Booking capacity digest failed:", err?.message || err);
        }
      },
      { scheduled: true, timezone: tz }
    );
  }

  console.log(`✅ [WhatsApp Cron] Admin MIS (Marathi) @ ${misCron} (${tz}).`);
  // Day-end sales report — 8:00 PM IST (only remaining window report)
  const dayEndEnabled = process.env.WHATSAPP_DAY_END_REPORT_ENABLED !== "false";
  const dayEndCron = process.env.WHATSAPP_DAY_END_REPORT_CRON || "0 20 * * *";
  if (dayEndEnabled) {
    cron.schedule(
      dayEndCron,
      async () => {
        console.log(`[WhatsApp Cron] Running day-end sales report (${dayEndCron})...`);
        try {
          const result = await sendDayEndOpsWhatsappAlert();
          console.log("[WhatsApp Cron] Day-end sales report done:", {
            sent: result.sent,
            delivered: result.delivered,
            chunks: result.chunks,
            dateKey: result.dateKey,
            skipped: result.skipped,
            reason: result.reason,
          });
        } catch (err) {
          console.error("[WhatsApp Cron] Day-end sales report failed:", err?.message || err);
        }
      },
      { scheduled: true, timezone: tz }
    );
  }

  if (intradayEnabled) {
    console.log(
      `✅ [WhatsApp Cron] Intraday 2.5h ops @ ${intradayCrons.join(" | ")} (${tz}).`
    );
  } else {
    console.log("[WhatsApp Cron] Intraday 2.5h ops report disabled.");
  }
  if (dayEndEnabled) {
    console.log(`✅ [WhatsApp Cron] Day-end sales report @ ${dayEndCron} (${tz}).`);
  } else {
    console.log("[WhatsApp Cron] Day-end sales report disabled.");
  }
  if (process.env.WHATSAPP_LEGACY_DAILY_SUMMARY === "true") {
    console.log("✅ [WhatsApp Cron] Legacy daily summary enabled.");
  }
  if (opsEnabled) {
    console.log(`✅ [WhatsApp Cron] Ops digest @ ${opsCron} (${tz}).`);
  } else {
    console.log("[WhatsApp Cron] Ops digest disabled.");
  }
  if (bookingCapEnabled) {
    console.log(`✅ [WhatsApp Cron] Booking capacity @ ${slotCron} (${tz}).`);
  } else {
    console.log("[WhatsApp Cron] Booking capacity digest disabled.");
  }

  // Session watchdog — safety net if the linked session stays down (every 5 min). Never opens a QR window.
  const watchdogCron = process.env.WHATSAPP_SESSION_WATCHDOG_CRON || "*/5 * * * *";
  const watchdogEnabled =
    process.env.WHATSAPP_SESSION_WATCHDOG_ENABLED === "true" ||
    (process.env.NODE_ENV === "production" &&
      process.env.WHATSAPP_SESSION_WATCHDOG_ENABLED !== "false");

  if (!watchdogEnabled) {
    console.log(
      "[WhatsApp Cron] Session watchdog off in development (set WHATSAPP_SESSION_WATCHDOG_ENABLED=true to enable)."
    );
  } else {
    cron.schedule(
      watchdogCron,
      async () => {
        if (isWhatsAppReady || isWhatsAppConnectionInProgress()) return;
        console.warn("[WhatsApp Cron] Session watchdog — client not ready, attempting reconnect...");
        try {
          const result = await ensureWhatsAppConnected("cron-watchdog");
          if (!result.ok && result.reason !== "needs_scan") {
            console.warn("[WhatsApp Cron] Session watchdog reconnect failed:", result.reason);
          }
        } catch (err) {
          console.error("[WhatsApp Cron] Session watchdog error:", err?.message || err);
        }
      },
      { scheduled: true, timezone: tz }
    );
    console.log(`✅ [WhatsApp Cron] Session watchdog @ ${watchdogCron} (${tz}).`);
  }
}

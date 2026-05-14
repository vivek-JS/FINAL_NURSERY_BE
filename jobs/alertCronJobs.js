/**
 * Alert Cron Jobs — scheduled WhatsApp notifications.
 *
 * Call initAlertCronJobs() once at server startup (in index.js or app.js).
 * Requires node-cron (already installed).
 */

import cron from "node-cron";
import Order from "../models/order.model.js";
import { sendDailySummaryAlert } from "../services/whatsappAlertService.js";

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

  // Daily summary at 8:00 PM IST (UTC+5:30 → 14:30 UTC)
  cron.schedule(
    "30 14 * * *",
    async () => {
      console.log("[WhatsApp Cron] Running daily summary job...");
      try {
        const summary = await buildDailySummary();
        await sendDailySummaryAlert(summary);
        console.log("[WhatsApp Cron] Daily summary sent.");
      } catch (err) {
        console.error("[WhatsApp Cron] Daily summary job failed:", err?.message || err);
      }
    },
    {
      scheduled: true,
      timezone: "Asia/Kolkata",
    }
  );

  console.log("✅ [WhatsApp Cron] Daily summary scheduled at 8:00 PM IST.");
}

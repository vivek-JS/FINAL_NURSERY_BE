/**
 * Cron: send WATI delivery_final_second to past-due + due-in-7-days orders.
 */

import cron from "node-cron";
import { runDeliveryFinalSecondScan } from "../services/deliveryFinalSecondWhatsapp.service.js";

export function initDeliveryFinalSecondCronJobs() {
  if (process.env.WATI_DELIVERY_FINAL_SECOND_ENABLED !== "true") {
    console.log("[WATI Cron] delivery_final_second cron off (set WATI_DELIVERY_FINAL_SECOND_ENABLED=true to enable).");
    return;
  }
  if (process.env.WATI_DELIVERY_FINAL_SECOND_ALLOW_AUTO !== "true") {
    console.log("[WATI Cron] delivery_final_second cron skipped — manual-only mode (no ALLOW_AUTO).");
    return;
  }

  const tz = "Asia/Kolkata";
  const cronExpr = process.env.WATI_DELIVERY_FINAL_SECOND_CRON || "0 9 * * *";

  cron.schedule(
    cronExpr,
    async () => {
      console.log("[WATI Cron] Running delivery_final_second scan...");
      try {
        const result = await runDeliveryFinalSecondScan();
        console.log("[WATI Cron] delivery_final_second done:", JSON.stringify(result));
      } catch (err) {
        console.error("[WATI Cron] delivery_final_second failed:", err?.message || err);
      }
    },
    { scheduled: true, timezone: tz }
  );

  console.log(`✅ [WATI Cron] delivery_final_second @ ${cronExpr} (${tz}).`);
}

/**
 * Cron: move open-pipeline orders off expired booking slots to the next slot window.
 */

import cron from "node-cron";
import { runPastDueSlotRollover } from "../services/pastDueSlotRollover.service.js";

export function initPastDueSlotRolloverCronJobs() {
  if (process.env.PAST_DUE_SLOT_ROLLOVER_ENABLED !== "true") {
    console.log(
      "[PastDueRollover] cron off (set PAST_DUE_SLOT_ROLLOVER_ENABLED=true to enable)."
    );
    return;
  }

  const cronExpr = process.env.PAST_DUE_SLOT_ROLLOVER_CRON || "0 1 * * *";
  const tz = process.env.PAST_DUE_SLOT_ROLLOVER_TZ || "Asia/Kolkata";

  cron.schedule(
    cronExpr,
    async () => {
      try {
        console.log("[PastDueRollover] cron started");
        const summary = await runPastDueSlotRollover();
        console.log("[PastDueRollover] cron finished:", summary);
      } catch (err) {
        console.error("[PastDueRollover] cron error:", err?.message || err);
      }
    },
    { scheduled: true, timezone: tz }
  );

  console.log(`✅ [PastDueRollover] cron @ ${cronExpr} (${tz}).`);
}

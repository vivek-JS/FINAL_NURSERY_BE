/**
 * Cron: relocate calendar-ready lagwad lines to current ongoing booking slot.
 */

import cron from "node-cron";
import { runCalendarReadySlotRelocate } from "../services/calendarReadySlotRelocate.service.js";
import { runExpiredReadyRollAuto } from "../services/rollExpiredSlotAvailable.service.js";

export function initCalendarReadySlotRelocateCronJobs() {
  if (process.env.CALENDAR_READY_SLOT_RELOCATE_ENABLED !== "true") {
    console.log(
      "[CalendarReadyRelocate] cron off (set CALENDAR_READY_SLOT_RELOCATE_ENABLED=true)."
    );
    return;
  }

  const cronExpr = process.env.CALENDAR_READY_SLOT_RELOCATE_CRON || "15 1 * * *";
  const tz = process.env.CALENDAR_READY_SLOT_RELOCATE_TZ || "Asia/Kolkata";

  cron.schedule(
    cronExpr,
    async () => {
      try {
        console.log("[CalendarReadyRelocate] cron started");
        const relocateSummary = await runCalendarReadySlotRelocate();
        console.log("[CalendarReadyRelocate] finished:", relocateSummary);
        const rollSummary = await runExpiredReadyRollAuto();
        console.log("[ExpiredReadyRoll] finished:", rollSummary);
      } catch (err) {
        console.error("[CalendarReadyRelocate] cron error:", err?.message || err);
      }
    },
    { scheduled: true, timezone: tz }
  );

  console.log(`✅ [CalendarReadyRelocate] cron @ ${cronExpr} (${tz}).`);
}

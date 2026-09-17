/**
 * Cron: relocate calendar-ready lagwad lines to current ongoing booking slot.
 */

import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import cron from "node-cron";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "../.env") });
import { runCalendarReadySlotRelocate } from "../services/calendarReadySlotRelocate.service.js";
import { runExpiredReadyRollAuto } from "../services/rollExpiredSlotAvailable.service.js";
import { isSlotEndNightlyMasterEnabled } from "./slotEndNightlyCron.js";

export function initCalendarReadySlotRelocateCronJobs() {
  if (isSlotEndNightlyMasterEnabled()) {
    console.log(
      "[CalendarReadyRelocate] legacy cron skipped (SLOT_END_NIGHTLY_ENABLED=true — use unified SlotEndNightly job)."
    );
    return;
  }

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
        console.log("[ExpiredSlotRoll] finished:", rollSummary);
      } catch (err) {
        console.error("[CalendarReadyRelocate] cron error:", err?.message || err);
      }
    },
    { scheduled: true, timezone: tz }
  );

  console.log(`✅ [CalendarReadyRelocate] cron @ ${cronExpr} (${tz}).`);
}

import cron from "node-cron";
import { autoClockOutOpenSessions } from "../controllers/fieldAttendance.controller.js";

export function initFieldAttendanceCron() {
  cron.schedule(
    "0 23 * * *",
    async () => {
      try {
        const closed = await autoClockOutOpenSessions(new Date());
        console.log(`[FieldAttendance] Auto clock-out at 11 PM IST closed ${closed} session(s).`);
      } catch (err) {
        console.error("[FieldAttendance] Auto clock-out failed:", err?.message || err);
      }
    },
    { timezone: "Asia/Kolkata" }
  );
}

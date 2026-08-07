/**
 * Face Recognition Attendance app — 9:30 AM IST daily check-in reminder.
 * Call initAttendanceReminderCron() once at server startup (mirrors alertCronJobs.js).
 * Requires node-cron (already installed).
 */
import cron from "node-cron";
import moment from "moment";
import User from "../models/user.model.js";
import AttendanceRecord from "../models/attendanceRecord.model.js";
import { sendAttendanceReminderNotification } from "../utility/attendanceNotification.js";
import { getIstTodayYmd } from "../utility/istCalendar.js";

const TZ = "Asia/Kolkata";
const BATCH_SIZE = 90; // Expo push API accepts up to 100 messages per request

async function runDailyReminder() {
  const todayYmd = getIstTodayYmd();
  const isSunday = moment().utcOffset(330).day() === 0;
  if (isSunday) {
    console.log("[AttendanceReminder] Sunday — skipping reminder run.");
    return;
  }

  const registeredEmployees = await User.find({
    faceRegistrationStatus: "REGISTERED",
    isDisabled: false,
    expoPushToken: { $ne: null },
  })
    .select("_id expoPushToken")
    .lean();

  if (!registeredEmployees.length) return;

  const alreadyCheckedInIds = new Set(
    (
      await AttendanceRecord.find({ type: "CHECK_IN", date: todayYmd }).distinct("employee")
    ).map(String)
  );

  const pendingTokens = registeredEmployees
    .filter((e) => !alreadyCheckedInIds.has(String(e._id)))
    .map((e) => e.expoPushToken)
    .filter(Boolean);

  if (!pendingTokens.length) {
    console.log("[AttendanceReminder] Everyone has already checked in — nothing to send.");
    return;
  }

  for (let i = 0; i < pendingTokens.length; i += BATCH_SIZE) {
    const batch = pendingTokens.slice(i, i + BATCH_SIZE);
    await sendAttendanceReminderNotification(batch);
  }

  console.log(`[AttendanceReminder] Reminder sent to ${pendingTokens.length} employee(s).`);
}

export function initAttendanceReminderCron() {
  if (process.env.ATTENDANCE_REMINDER_ENABLED === "false") {
    console.log("[AttendanceReminder] Disabled via ATTENDANCE_REMINDER_ENABLED=false — skipping cron registration.");
    return;
  }

  const cronExpr = process.env.ATTENDANCE_REMINDER_CRON || "30 9 * * *"; // 9:30 AM IST

  cron.schedule(
    cronExpr,
    async () => {
      console.log("[AttendanceReminder] Running daily check-in reminder job...");
      try {
        await runDailyReminder();
      } catch (err) {
        console.error("[AttendanceReminder] Job failed:", err?.message || err);
      }
    },
    { scheduled: true, timezone: TZ }
  );

  console.log(`[AttendanceReminder] Cron scheduled: "${cronExpr}" (${TZ}).`);
}

export { runDailyReminder };

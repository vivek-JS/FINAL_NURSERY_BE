/**
 * Face Recognition Attendance app — push notification helpers.
 * Thin wrappers around the shared `sendPushNotification` (same Expo push
 * service already used for payments/orders), so the attendance app gets the
 * same delivery guarantees without a separate provider integration.
 */
import { sendPushNotification } from "./pushNotification.js";

const ATTENDANCE_TYPE_LABEL = {
  CHECK_IN: "Check-in",
  CHECK_OUT: "Check-out",
  BREAK_START: "Break start",
  BREAK_END: "Break end",
};

export async function sendAttendanceSuccessNotification(expoPushToken, type, extra = {}) {
  const label = ATTENDANCE_TYPE_LABEL[type] || type;
  return sendPushNotification(
    expoPushToken,
    "✅ Attendance recorded",
    `${label} marked successfully.`,
    { type: "attendance-success", attendanceType: type, ...extra },
    "attendance"
  );
}

export async function sendAttendanceFailedNotification(expoPushToken, reason, extra = {}) {
  return sendPushNotification(
    expoPushToken,
    "❌ Attendance failed",
    reason || "We couldn't verify your face. Please try again.",
    { type: "attendance-failed", ...extra },
    "attendance"
  );
}

export async function sendAlreadyCheckedInNotification(expoPushToken, message, extra = {}) {
  return sendPushNotification(
    expoPushToken,
    "ℹ️ Already recorded",
    message || "This attendance action was already recorded today.",
    { type: "attendance-duplicate", ...extra },
    "attendance"
  );
}

export async function sendAttendanceReminderNotification(expoPushTokens) {
  return sendPushNotification(
    expoPushTokens,
    "⏰ Attendance reminder",
    "Don't forget to mark your attendance for today.",
    { type: "attendance-reminder" },
    "attendance"
  );
}

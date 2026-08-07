import axios from "axios";
import { getWatiToken, getWatiBaseUrl, isWatiConfigured } from "../config/wati.config.js";

/**
 * Delivers a password-reset OTP over WhatsApp using the existing WATI cloud API
 * integration (see controllers/watiProxy.controller.js for the same client pattern).
 * Requires an approved WATI template (FACE_ATTENDANCE_OTP_TEMPLATE_NAME) with a single
 * body parameter for the OTP code, since WhatsApp forbids free-form text outside the
 * 24h session window. Falls back to a console log (same shape as WHATSAPP_ALERTS_ENABLED
 * fallback elsewhere in this codebase) when WATI/template isn't configured, so local/dev
 * environments can still exercise the flow end-to-end.
 * @returns {Promise<{delivered: boolean, channel: 'wati'|'console', error?: string}>}
 */
export async function sendPasswordResetOtp(phoneNumber, otp) {
  const templateName = process.env.FACE_ATTENDANCE_OTP_TEMPLATE_NAME;

  if (!isWatiConfigured() || !templateName) {
    console.warn(
      `[PasswordResetOTP] WATI not configured (or FACE_ATTENDANCE_OTP_TEMPLATE_NAME unset) — ` +
        `logging OTP for ${phoneNumber} instead of sending WhatsApp message: ${otp}`
    );
    return { delivered: false, channel: "console" };
  }

  try {
    const token = getWatiToken().trim();
    const authHeader = token.toLowerCase().startsWith("bearer ") ? token : `Bearer ${token}`;
    const client = axios.create({
      baseURL: getWatiBaseUrl(),
      timeout: 15000,
      headers: {
        Authorization: authHeader,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
    });

    await client.post(
      `/api/v1/sendTemplateMessage?whatsappNumber=${encodeURIComponent(String(phoneNumber))}`,
      {
        template_name: templateName,
        language: { code: "en" },
        broadcast_name: `AttendanceOtp_${Date.now()}`,
        parameters: [{ name: "1", value: otp }],
      }
    );

    return { delivered: true, channel: "wati" };
  } catch (error) {
    console.error("[PasswordResetOTP] Failed to send via WATI:", error.response?.data || error.message);
    return { delivered: false, channel: "wati", error: error.message };
  }
}

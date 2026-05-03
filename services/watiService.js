import axios from "axios";
import { getWatiBaseUrl, getWatiToken } from "../config/wati.config.js";

/**
 * Send a session file message (PDF URL) via WATI.
 * POST {base}/api/v1/sendSessionFileMessage
 *
 * @param {object} params
 * @param {string} params.whatsappNumber - Recipient WA id / phone as required by WATI
 * @param {string} params.fileUrl - Public HTTPS URL of the PDF
 * @param {string} params.caption
 */
export async function sendSessionFileMessage({
  whatsappNumber,
  fileUrl,
  caption,
}) {
  const baseUrl = getWatiBaseUrl();
  const token = getWatiToken();

  if (!baseUrl) {
    throw new Error("WATI base URL is not configured (WATI_BASE_URL / WATI_URL)");
  }
  if (!token) {
    throw new Error("WATI API token is not configured (WATI_TOKEN)");
  }

  const authHeader = token.startsWith("Bearer ") ? token : `Bearer ${token}`;
  const url = `${baseUrl.replace(/\/+$/, "")}/api/v1/sendSessionFileMessage`;

  const { data, status } = await axios.post(
    url,
    {
      whatsappNumber,
      fileUrl,
      caption,
    },
    {
      headers: {
        Authorization: authHeader,
        "Content-Type": "application/json",
      },
      timeout: 120000,
      validateStatus: () => true,
    }
  );

  if (status < 200 || status >= 300) {
    const detail =
      typeof data === "object" ? JSON.stringify(data) : String(data);
    throw new Error(`WATI sendSessionFileMessage failed (${status}): ${detail}`);
  }

  return data;
}

/**
 * Plain session text (figures summary). Matches working pattern in whatsappOrderBot:
 * POST {base}/api/v1/sendSessionMessage/{whatsappDigits}?messageText=...
 *
 * @param {object} params
 * @param {string} params.whatsappNumber - Digits only, e.g. 919876543210
 * @param {string} params.messageText
 */
export async function sendSessionTextMessage({ whatsappNumber, messageText }) {
  const baseUrl = getWatiBaseUrl();
  const token = getWatiToken();

  if (!baseUrl) {
    throw new Error("WATI base URL is not configured (WATI_BASE_URL / WATI_URL)");
  }
  if (!token) {
    throw new Error("WATI API token is not configured (WATI_TOKEN)");
  }

  const digits = String(whatsappNumber || "").replace(/\D/g, "");
  if (!digits) {
    throw new Error("sendSessionTextMessage: whatsappNumber is empty");
  }

  const authHeader = token.startsWith("Bearer ") ? token : `Bearer ${token}`;
  const root = baseUrl.replace(/\/+$/, "");
  const url = `${root}/api/v1/sendSessionMessage/${digits}?messageText=${encodeURIComponent(
    messageText || ""
  )}`;

  const { data, status } = await axios.post(
    url,
    {},
    {
      headers: {
        Authorization: authHeader,
        "Content-Type": "application/json",
      },
      timeout: 60000,
      validateStatus: () => true,
    }
  );

  if (status < 200 || status >= 300) {
    const detail =
      typeof data === "object" ? JSON.stringify(data) : String(data);
    throw new Error(`WATI sendSessionMessage failed (${status}): ${detail}`);
  }

  return data;
}

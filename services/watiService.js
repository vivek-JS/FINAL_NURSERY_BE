import axios from "axios";
import FormData from "form-data";
import { getWatiBaseUrl, getWatiToken } from "../config/wati.config.js";

/**
 * Send a file in an open WhatsApp session.
 * Official WATI v1: POST {base}/api/v1/sendSessionFile/{whatsappNumber} (multipart `file`, optional `caption` query).
 * https://docs.wati.io/reference/post_api-v1-sendsessionfile-whatsappnumber
 *
 * Prefer `fileBuffer` (no public URL / Spaces required). If only `fileUrl` is set, falls back to JSON
 * `sendSessionFileMessage` (works on some tenants; may 404 or fail if URL is not public).
 *
 * @param {object} params
 * @param {string} params.whatsappNumber - Digits, e.g. 919876543210
 * @param {string} [params.caption]
 * @param {Buffer} [params.fileBuffer] - PDF bytes (recommended)
 * @param {string} [params.filename] - e.g. booking-20260103.pdf
 * @param {string} [params.fileUrl] - Public HTTPS URL (legacy fallback)
 */
export async function sendSessionFileMessage({
  whatsappNumber,
  fileUrl,
  caption,
  fileBuffer,
  filename = "document.pdf",
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
  const root = baseUrl.replace(/\/+$/, "");
  const digits = String(whatsappNumber || "").replace(/\D/g, "");
  if (!digits) {
    throw new Error("sendSessionFileMessage: whatsappNumber is empty");
  }

  if (fileBuffer && Buffer.isBuffer(fileBuffer)) {
    const form = new FormData();
    form.append("file", fileBuffer, {
      filename: String(filename || "report.pdf").replace(/[^\w.\-]/g, "_") || "report.pdf",
      contentType: "application/pdf",
    });
    const q = caption != null && caption !== "" ? `?caption=${encodeURIComponent(caption)}` : "";
    const url = `${root}/api/v1/sendSessionFile/${digits}${q}`;

    const { data, status } = await axios.post(url, form, {
      headers: {
        Authorization: authHeader,
        ...form.getHeaders(),
      },
      timeout: 120000,
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
      validateStatus: () => true,
    });

    if (status < 200 || status >= 300) {
      const detail =
        typeof data === "object" ? JSON.stringify(data) : String(data);
      throw new Error(`WATI sendSessionFile failed (${status}): ${detail}`);
    }

    return data;
  }

  if (fileUrl) {
    const url = `${root}/api/v1/sendSessionFileMessage`;
    const { data, status } = await axios.post(
      url,
      {
        whatsappNumber: digits,
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

  throw new Error(
    "sendSessionFileMessage: provide fileBuffer (recommended) or fileUrl"
  );
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

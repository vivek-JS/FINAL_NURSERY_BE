import axios from "axios";
import catchAsync from "../utility/catchAsync.js";
import AppError from "../utility/appError.js";
import generateResponse from "../utility/responseFormat.js";
import {
  getExotelApiKey,
  getExotelApiToken,
  getExotelAccountSid,
  getExotelSubdomain,
  getExotelSenderId,
  isExotelConfigured,
} from "../config/exotel.config.js";

const exotelClient = () => {
  const apiKey = getExotelApiKey();
  const apiToken = getExotelApiToken();
  const accountSid = getExotelAccountSid();
  const subdomain = getExotelSubdomain();
  if (!apiKey || !apiToken || !accountSid) {
    throw new AppError(
      "Exotel is not configured. Set EXOTEL_API_KEY, EXOTEL_API_TOKEN, and EXOTEL_ACCOUNT_SID in environment.",
      503
    );
  }
  const baseURL = `https://${subdomain}/v1/Accounts/${accountSid}`;
  return axios.create({
    baseURL,
    timeout: 30000,
    auth: {
      username: apiKey,
      password: apiToken,
    },
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
  });
};

/**
 * POST /api/v1/exotel/send
 * Body: { to, body, from? } (from optional, uses EXOTEL_SENDER_ID if not provided)
 * Optional for India DLT: dltEntityId, dltTemplateId, smsType
 */
export const sendSms = catchAsync(async (req, res) => {
  const client = exotelClient();
  const { to, body, from, dltEntityId, dltTemplateId, smsType, customField, priority } = req.body;

  if (!to || !body || !String(body).trim()) {
    throw new AppError("to and body are required.", 400);
  }

  const fromValue = from || getExotelSenderId();
  const params = new URLSearchParams();
  params.append("From", fromValue);
  params.append("To", String(to).trim());
  params.append("Body", String(body).trim());
  if (dltEntityId) params.append("DltEntityId", dltEntityId);
  if (dltTemplateId) params.append("DltTemplateId", dltTemplateId);
  if (smsType) params.append("SmsType", smsType);
  if (customField) params.append("CustomField", customField);
  if (priority) params.append("Priority", priority);

  try {
    const response = await client.post("/Sms/send.json", params.toString());
    const data = response.data?.SMSMessage || response.data;
    return res
      .status(200)
      .json(generateResponse("Success", "SMS sent", data, undefined));
  } catch (err) {
    const status = err.response?.status || 502;
    const body = err.response?.data;
    const exotelMessage =
      body?.RestException?.Message ||
      body?.message ||
      body?.Message ||
      (typeof body === "string" ? body : null);
    const exotelCode = body?.RestException?.Code || body?.Code || body?.code;
    const parts = [];
    if (exotelMessage) parts.push(exotelMessage);
    if (exotelCode) parts.push(`code: ${exotelCode}`);
    const detail = parts.length ? parts.join(" — ") : (err.message || "Exotel request failed.");
    throw new AppError(detail, status);
  }
});

/**
 * GET /api/v1/exotel/test
 * Check if Exotel is configured and credentials are valid (optional: lightweight check)
 */
export const testConnection = catchAsync(async (req, res) => {
  if (!isExotelConfigured()) {
    return res.status(200).json(
      generateResponse("Success", "Exotel not configured", { configured: false }, undefined)
    );
  }
  return res.status(200).json(
    generateResponse("Success", "Exotel configured", { configured: true }, undefined)
  );
});

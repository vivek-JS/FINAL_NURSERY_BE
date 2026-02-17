import axios from "axios";
import catchAsync from "../utility/catchAsync.js";
import AppError from "../utility/appError.js";
import { getWatiToken, getWatiBaseUrl, isWatiConfigured } from "../config/wati.config.js";
import generateResponse from "../utility/responseFormat.js";

const watiClient = (req) => {
  const token = getWatiToken();
  const baseURL = getWatiBaseUrl();
  if (!token || !baseURL) {
    throw new AppError("WATI is not configured. Set WATI_TOKEN and WATI_BASE_URL in environment.", 503);
  }
  // Env may store "Bearer <token>" or just "<token>"
  const authHeader = token.trim().toLowerCase().startsWith("bearer ")
    ? token.trim()
    : `Bearer ${token.trim()}`;
  return axios.create({
    baseURL,
    timeout: 30000,
    headers: {
      Authorization: authHeader,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
  });
};

export const getMessageTemplates = catchAsync(async (req, res) => {
  const client = watiClient(req);
  const { pageSize = 10, pageNumber = 1, channelPhoneNumber = "" } = req.query;
  const response = await client.get("/api/v1/getMessageTemplates", {
    params: { pageSize, pageNumber, channelPhoneNumber },
  });
  return res.status(200).json(generateResponse("Success", "Templates fetched", response.data, undefined));
});

export const testConnection = catchAsync(async (req, res) => {
  if (!isWatiConfigured()) {
    return res.status(200).json(
      generateResponse("Success", "WATI not configured", { configured: false }, undefined)
    );
  }
  const client = watiClient(req);
  const response = await client.get("/api/v1/getContacts", {
    params: { pageSize: 1, pageNumber: 1 },
  });
  return res.status(200).json(
    generateResponse("Success", "WATI API connection successful", { configured: true, ...response.data }, undefined)
  );
});

export const sendTemplateMessage = catchAsync(async (req, res) => {
  const client = watiClient(req);
  const { whatsappNumber, ...body } = req.body;
  if (!whatsappNumber) {
    throw new AppError("whatsappNumber is required", 400);
  }
  const payload = {
    template_name: body.templateName,
    language: { code: body.languageCode || "en" },
    broadcast_name: body.broadcastName || `Single_${Date.now()}`,
    parameters: body.parameters || [],
    channel_number: body.channelNumber || "917276386452",
  };
  const response = await client.post(
    `/api/v1/sendTemplateMessage?whatsappNumber=${encodeURIComponent(whatsappNumber)}`,
    payload
  );
  return res.status(200).json(generateResponse("Success", "Message sent", response.data, undefined));
});

export const sendTemplateMessages = catchAsync(async (req, res) => {
  const client = watiClient(req);
  const body = req.body;
  const payload = {
    template_name: body.templateName,
    language: { code: body.languageCode || "en" },
    broadcast_name: body.broadcastName || `Campaign_${Date.now()}`,
    parameters: body.parameters || [],
    contacts: body.contacts || [],
    channel_number: body.channelNumber || "917276386452",
  };
  const response = await client.post("/api/v1/sendTemplateMessages", payload);
  return res.status(200).json(generateResponse("Success", "Messages sent", response.data, undefined));
});

export const getContacts = catchAsync(async (req, res) => {
  const client = watiClient(req);
  const { pageSize = 100, pageNumber = 1 } = req.query;
  const response = await client.get("/api/v1/getContacts", {
    params: { pageSize, pageNumber },
  });
  return res.status(200).json(generateResponse("Success", "Contacts fetched", response.data, undefined));
});

export const sendTextMessage = catchAsync(async (req, res) => {
  const client = watiClient(req);
  const { message, contacts } = req.body;
  const response = await client.post("/api/v1/sendMessage", { message, contacts: contacts || [] });
  return res.status(200).json(generateResponse("Success", "Message sent", response.data, undefined));
});

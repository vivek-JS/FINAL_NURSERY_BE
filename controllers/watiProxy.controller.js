import axios from "axios";
import catchAsync from "../utility/catchAsync.js";
import AppError from "../utility/appError.js";
import { getWatiToken, getWatiBaseUrl, isWatiConfigured } from "../config/wati.config.js";
import generateResponse from "../utility/responseFormat.js";
import WhatsAppBroadcast from "../models/whatsappBroadcast.model.js";

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
  const contacts = body.contacts || [];
  const globalParams = body.parameters || [];

  // WATI V1 expects receivers with customParams per contact
  const receivers = contacts.map((c) => {
    const whatsappNumber = String(c.whatsappMsisdn || c.phone || c.mobile || "")
      .replace(/\D/g, "")
      .replace(/^0+/, "")
      .replace(/^(\d{10})$/, "91$1");
    const customParams = (c.customParams || []).length > 0
      ? c.customParams.map((p) => ({ name: p.name || p.paramName, value: String(p.value || p.paramValue || "") }))
      : globalParams.map((p) => ({ name: p.name, value: String(p.value || "") }));
    return { whatsappNumber, customParams };
  });

  const payload = {
    template_name: body.templateName,
    language: { code: body.languageCode || "en" },
    broadcast_name: body.broadcastName || `Campaign_${Date.now()}`,
    receivers,
    channel_number: body.channelNumber || "917276386452",
  };

  console.log("[WATI] sendTemplateMessages:", {
    templateName: payload.template_name,
    receiversCount: receivers.length,
    sampleReceiver: receivers[0],
  });

  const response = await client.post("/api/v1/sendTemplateMessages", payload);
  // Create a Broadcast record for UI/aggregation (best-effort, do not fail on error)
  try {
    const isValidObjectId = (id) => id && /^[a-f0-9]{24}$/i.test(String(id));
    const broadcastContacts = contacts.map((c) => {
      const phone = String(c.whatsappMsisdn || c.phone || c.mobile || "").replace(/\D/g, "").replace(/^(\d{10})$/, "91$1") || "";
      return {
        phone: phone || "unknown",
        name: c.name || "",
        farmerId: isValidObjectId(c.farmerId) ? c.farmerId : null,
        leadId: isValidObjectId(c.leadId) ? c.leadId : null,
      };
    });
    await WhatsAppBroadcast.create({
      name: payload.broadcast_name || `Campaign_${Date.now()}`,
      templateName: payload.template_name || body.templateName,
      contacts: broadcastContacts,
      sentAt: new Date(),
      status: "sent",
      meta: { watiResponse: response.data || null }
    });
  } catch (e) {
    console.warn("Could not create WhatsAppBroadcast:", e.message);
  }
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

export const getMessageDetails = catchAsync(async (req, res) => {
  const client = watiClient(req);
  const { phone, localMessageId } = req.params;
  if (!phone || !localMessageId) {
    throw new AppError("phone and localMessageId are required", 400);
  }
  // Try WATI message lookup endpoint
  const path = `/api/v1/whatsapp-messages/${encodeURIComponent(phone)}/${encodeURIComponent(localMessageId)}`;
  const response = await client.get(path);
  return res.status(200).json(generateResponse("Success", "Message fetched", response.data, undefined));
});

export const sendTextMessage = catchAsync(async (req, res) => {
  const client = watiClient(req);
  const { message, contacts } = req.body;
  const response = await client.post("/api/v1/sendMessage", { message, contacts: contacts || [] });
  return res.status(200).json(generateResponse("Success", "Message sent", response.data, undefined));
});

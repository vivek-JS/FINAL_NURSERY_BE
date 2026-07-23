import fetch from "node-fetch";
import { getWatiBaseUrl, getWatiToken } from "../config/wati.config.js";
import {
  watiPlantAndSubtypeParams,
  WATI_MERGED_SUBTYPE_PLACEHOLDER,
  isBananaPlantName,
} from "./watiPlantText.js";

export { isBananaPlantName };

/** Normalize to 10-digit Indian mobile for logs; API uses 91 prefix. */
export function normalizeWatiMobile10(mobileNumber) {
  const clean = String(mobileNumber ?? "").replace(/\D/g, "");
  if (clean.length === 12 && clean.startsWith("91")) return clean.slice(2);
  if (clean.length > 10) return "";
  return clean;
}

/** Farmer uses mobileNumber; salesperson/dealer copy may use phoneNumber. */
export function resolveWatiSendMobile(recipient) {
  if (!recipient) return null;
  const raw = recipient.mobileNumber ?? recipient.phoneNumber;
  const ten = normalizeWatiMobile10(raw);
  return ten.length === 10 ? ten : null;
}

export function buildWatiSendRecipient(recipient, extra = {}) {
  const mobile = resolveWatiSendMobile(recipient);
  if (!mobile) return null;
  const base =
    typeof recipient.toObject === "function" ? recipient.toObject() : { ...recipient };
  return { ...base, ...extra, mobileNumber: mobile };
}

/**
 * WATI often returns HTTP 200 with result:false or invalid WhatsApp number.
 * @returns {{ ok: boolean, error?: string|object, localMessageId?: string }}
 */
export function interpretWatiTemplateResponse(data, httpOk) {
  if (!httpOk) {
    return {
      ok: false,
      error: data?.info || data?.message || data?.error || data || "HTTP error",
    };
  }

  if (!data || typeof data !== "object") {
    return { ok: false, error: "Empty or invalid WATI response body" };
  }

  if (data.result === false) {
    return {
      ok: false,
      error: data.info || data.message || data.error || "WATI result:false",
    };
  }

  const receivers = Array.isArray(data.receivers) ? data.receivers : [];
  if (receivers.length > 0) {
    const bad = receivers.filter(
      (r) => r.isValidWhatsAppNumber === false || (r.errors && r.errors.length > 0)
    );
    if (bad.length > 0) {
      const detail = bad
        .map((r) => ({
          waId: r.waId,
          errors: r.errors,
          isValidWhatsAppNumber: r.isValidWhatsAppNumber,
        }));
      return {
        ok: false,
        error: { message: "Invalid WhatsApp number or template rejected", receivers: detail },
        localMessageId: receivers[0]?.localMessageId || null,
      };
    }
  }

  if (data.validWhatsAppNumber === false) {
    return {
      ok: false,
      error: data.info || "Not a valid WhatsApp number (WATI)",
    };
  }

  const localMessageId =
    data.localMessageId ||
    data.local_message_id ||
    receivers[0]?.localMessageId ||
    null;

  return { ok: true, localMessageId };
}

/**
 * Send WhatsApp template message via WATI API
 * @param {string} mobileNumber - Farmer's mobile number (10 digits)
 * @param {string} templateName - WATI template name
 * @param {Array} parameters - Template parameters
 * @returns {Promise<Object>} WATI API response
 */
export async function sendWatiTemplateMessage(mobileNumber, templateName, parameters = []) {
  try {
    const WATI_URL =
      process.env.SEND_TEMPLATE_MESSAGE_URL ||
      `${getWatiBaseUrl()}/api/v1/sendTemplateMessage`;
    const WATI_TOKEN = getWatiToken();

    if (!WATI_TOKEN) {
      console.warn("⚠️ WATI_TOKEN not configured in environment variables");
      return { success: false, error: "WATI not configured" };
    }

    const phoneNumber = normalizeWatiMobile10(mobileNumber);
    if (!phoneNumber || phoneNumber.length !== 10) {
      return { success: false, error: `Invalid mobile: ${mobileNumber}` };
    }

    const channelNumber = process.env.WATI_CHANNEL_NUMBER || "917276386452";
    const body = {
      template_name: templateName,
      broadcast_name: `Order_${Date.now()}`,
      parameters: parameters,
      channel_number: channelNumber,
    };

    const waQuery = `91${phoneNumber}`;
    console.log(
      `📤 Sending WATI template "${templateName}" to ${phoneNumber} (API: ${waQuery}), channel: ${channelNumber}`
    );

    const authHeader = WATI_TOKEN.startsWith("Bearer ")
      ? WATI_TOKEN
      : `Bearer ${WATI_TOKEN}`;

    const response = await fetch(`${WATI_URL}?whatsappNumber=${waQuery}`, {
      method: "POST",
      body: JSON.stringify(body),
      headers: {
        "Content-Type": "application/json",
        Authorization: authHeader,
      },
      timeout: 25000,
    });

    let data;
    const rawText = await response.text();
    try {
      data = rawText ? JSON.parse(rawText) : {};
    } catch {
      data = { raw: rawText };
    }

    const verdict = interpretWatiTemplateResponse(data, response.ok);

    if (verdict.ok) {
      console.log(
        `✅ WATI template accepted for ${phoneNumber} (${templateName})` +
          (verdict.localMessageId ? ` id=${verdict.localMessageId}` : "")
      );
      return {
        success: true,
        data: { ...data, localMessageId: verdict.localMessageId },
      };
    }

    console.error(`❌ WATI template NOT delivered to ${phoneNumber} (${templateName}):`, verdict.error);
    console.error(`   WATI raw response:`, JSON.stringify(data).slice(0, 800));
    return { success: false, error: verdict.error, data };
  } catch (error) {
    console.error(`❌ Error sending WATI message:`, error.message);
    return { success: false, error: error.message };
  }
}

/**
 * Send order accepted WhatsApp message to farmer
 * @param {Object} farmer - Farmer details
 * @param {Object} orderDetails - Order details
 * @returns {Promise<Object>} Send result
 */
export async function sendOrderAcceptedWhatsApp(farmer, orderDetails) {
  try {
    const sendTo = buildWatiSendRecipient(farmer, {
      taluka:
        farmer?.talukaName ||
        farmer?.taluka ||
        orderDetails?.taluka ||
        "N/A",
    });
    if (!sendTo) {
      console.warn("⚠️ No farmer mobile number provided");
      return { success: false, error: "No mobile number" };
    }

    const {
      orderId,
      plantName,
      numberOfPlants,
      deliveryDate,
      rate,
      totalAmount,
    } = orderDetails;

    const { plantParam, subtypeParam } = watiPlantAndSubtypeParams(
      plantName,
      orderDetails.plantSubtype
    );
    const isPapayaAccept = /papaya/i.test(
      `${plantName || ""} ${orderDetails.plantSubtype || ""}`
    );
    const acceptPlant = isPapayaAccept ? "Papaya" : plantParam;
    const acceptSubtype = isPapayaAccept ? WATI_MERGED_SUBTYPE_PLACEHOLDER : subtypeParam;

    const templateOrderId =
      orderDetails.publicOrderCode?.toString() || orderId?.toString() || "N/A";

    // Format delivery date
    const formattedDate = deliveryDate
      ? new Date(deliveryDate).toLocaleDateString("en-IN", {
          day: "2-digit",
          month: "2-digit",
          year: "numeric",
        })
      : "To be confirmed";

    // Parameters for WATI template: order_accpeted_revamped
    const parameters = [
      { name: "name", value: sendTo.name || "Farmer" },
      { name: "id", value: templateOrderId },
      { name: "village", value: sendTo.village || "N/A" },
      { name: "taluka", value: sendTo.taluka || "N/A" },
      { name: "number", value: sendTo.mobileNumber?.toString() || "N/A" },
      { name: "plant", value: acceptPlant },
      { name: "subtype", value: acceptSubtype },
      { name: "total_booked", value: numberOfPlants?.toString() || "0" },
      { name: "rate", value: rate?.toString() || "0" },
      { name: "total", value: totalAmount?.toString() || "0" },
      { name: "advacne", value: orderDetails.advanceAmount?.toString() || "0" },  // Note: typo in template
      { name: "remaiing", value: orderDetails.remainingAmount?.toString() || "0" }, // Note: typo in template
      { name: "delivery", value: formattedDate },
    ];

    // WATI template name (approved template)
    const templateName = "order_accpeted_revamped";

    return await sendWatiTemplateMessage(
      sendTo.mobileNumber,
      templateName,
      parameters
    );
  } catch (error) {
    console.error("❌ Error in sendOrderAcceptedWhatsApp:", error);
    return { success: false, error: error.message };
  }
}

function watiParamValue(value, fallback = "N/A") {
  const s = String(value ?? "").trim();
  if (!s || s === "—" || s === "-") return fallback;
  return s;
}

/**
 * Dispatch notification — WATI template delivery_final_revamp (regular plant orders)
 * Placeholders: name, id, village, plant, subtype, total_dispatched, driver_name, vehicle_number, dispatch_date
 */
export async function sendOrderDispatchedWhatsAppDelivery1(farmer, details) {
  try {
    if (!farmer || !farmer.mobileNumber) {
      console.warn("⚠️ No farmer mobile number provided");
      return { success: false, error: "No mobile number" };
    }

    const formatIn = (d) =>
      d
        ? new Date(d).toLocaleDateString("en-IN", {
            day: "2-digit",
            month: "2-digit",
            year: "numeric",
          })
        : "N/A";

    const { plantParam, subtypeParam } = watiPlantAndSubtypeParams(
      details.plantName,
      details.plantSubtype
    );
    const isPapayaDispatch = /papaya/i.test(
      `${details.plantName || ""} ${details.plantSubtype || ""} ${plantParam || ""} ${subtypeParam || ""}`
    );

    if (isPapayaDispatch) {
      // Papaya dispatch uses dedicated template requested by operations team.
      // The message uses {{3}} for driver number.
      const papayaParams = [
        { name: "name", value: farmer.name || "Farmer" },
        { name: "id", value: details.publicOrderCode?.toString() || details.orderId?.toString() || "N/A" },
        { name: "driver_number", value: details.driverNumber || "N/A" },
      ];
      return await sendWatiTemplateMessage(farmer.mobileNumber, "driver_fianl", papayaParams);
    }

    const parameters = [
      { name: "name", value: watiParamValue(farmer.name, "Customer") },
      { name: "id", value: watiParamValue(details.publicOrderCode || details.orderId, "N/A") },
      { name: "village", value: watiParamValue(farmer.village, "N/A") },
      { name: "plant", value: watiParamValue(plantParam, "Plants") },
      { name: "subtype", value: watiParamValue(subtypeParam, "N/A") },
      { name: "total_dispatched", value: watiParamValue(details.totalDispatched ?? "0", "0") },
      { name: "driver_name", value: watiParamValue(details.driverName, "N/A") },
      { name: "vehicle_number", value: watiParamValue(details.vehicleNumber, "N/A") },
      { name: "dispatch_date", value: watiParamValue(formatIn(details.dispatchDate), "N/A") },
    ];

    if (farmer.sendToName) {
      console.log(
        `   📲 WATI dispatch → dealer ${farmer.sendToName} (${farmer.mobileNumber}); customer in template: ${parameters[0].value} / ${parameters[2].value}`
      );
    }

    return await sendWatiTemplateMessage(farmer.mobileNumber, "delivery_final_revamp", parameters);
  } catch (error) {
    console.error("❌ Error in sendOrderDispatchedWhatsAppDelivery1:", error);
    return { success: false, error: error.message };
  }
}

/**
 * Send order ready for dispatch WhatsApp message to farmer
 */
export async function sendOrderReadyWhatsApp(farmer, orderDetails) {
  try {
    if (!farmer || !farmer.mobileNumber) {
      console.warn("⚠️ No farmer mobile number provided");
      return { success: false, error: "No mobile number" };
    }

    const { orderId, plantName, numberOfPlants, deliveryDate } = orderDetails;

    const formattedDate = deliveryDate
      ? new Date(deliveryDate).toLocaleDateString("en-IN", {
          day: "2-digit",
          month: "2-digit",
          year: "numeric",
        })
      : "Soon";

    const parameters = [
      {
        name: "name",
        value: farmer.name || "Farmer",
      },
      {
        name: "orderNumber",
        value: orderId?.toString() || "N/A",
      },
      {
        name: "plant",
        value: plantName || "Plants",
      },
      {
        name: "quantity",
        value: numberOfPlants?.toString() || "0",
      },
      {
        name: "delivery",
        value: formattedDate,
      },
    ];

    const templateName = "order_ready"; // Update this with your actual template name

    return await sendWatiTemplateMessage(
      farmer.mobileNumber,
      templateName,
      parameters
    );
  } catch (error) {
    console.error("❌ Error in sendOrderReadyWhatsApp:", error);
    return { success: false, error: error.message };
  }
}

/**
 * Send payment reminder WhatsApp message to farmer
 * @param {Object} farmer - Farmer details
 * @param {Object} paymentDetails - Payment details
 * @returns {Promise<Object>} Send result
 */
export async function sendPaymentReminderWhatsApp(farmer, paymentDetails) {
  try {
    if (!farmer || !farmer.mobileNumber) {
      console.warn("⚠️ No farmer mobile number provided");
      return { success: false, error: "No mobile number" };
    }

    const { orderId, remainingAmount, dueDate } = paymentDetails;

    const formattedDate = dueDate
      ? new Date(dueDate).toLocaleDateString("en-IN", {
          day: "2-digit",
          month: "2-digit",
          year: "numeric",
        })
      : "Soon";

    const parameters = [
      {
        name: "name",
        value: farmer.name || "Farmer",
      },
      {
        name: "orderNumber",
        value: orderId?.toString() || "N/A",
      },
      {
        name: "amount",
        value: remainingAmount ? `₹${remainingAmount}` : "₹0",
      },
      {
        name: "dueDate",
        value: formattedDate,
      },
    ];

    const templateName = "payment_reminder"; // Update this with your actual template name

    return await sendWatiTemplateMessage(
      farmer.mobileNumber,
      templateName,
      parameters
    );
  } catch (error) {
    console.error("❌ Error in sendPaymentReminderWhatsApp:", error);
    return { success: false, error: error.message };
  }
}

/**
 * Send custom WhatsApp message to farmer
 * @param {string} mobileNumber - Mobile number
 * @param {string} templateName - Template name
 * @param {Object} customParams - Custom parameters
 * @returns {Promise<Object>} Send result
 */
export async function sendCustomWhatsApp(mobileNumber, templateName, customParams = {}) {
  try {
    const parameters = Object.entries(customParams).map(([key, value]) => ({
      name: key,
      value: value?.toString() || "",
    }));

    return await sendWatiTemplateMessage(mobileNumber, templateName, parameters);
  } catch (error) {
    console.error("❌ Error in sendCustomWhatsApp:", error);
    return { success: false, error: error.message };
  }
}


import fetch from "node-fetch";
import { getWatiBaseUrl, getWatiToken } from "../config/wati.config.js";
import {
  watiPlantAndSubtypeParams,
  WATI_MERGED_SUBTYPE_PLACEHOLDER,
} from "./watiPlantText.js";

/**
 * Send WhatsApp template message via WATI API
 * @param {string} mobileNumber - Farmer's mobile number (10 digits)
 * @param {string} templateName - WATI template name
 * @param {Array} parameters - Template parameters
 * @returns {Promise<Object>} WATI API response
 */
export async function sendWatiTemplateMessage(mobileNumber, templateName, parameters = []) {
  try {
    const WATI_URL = process.env.SEND_TEMPLATE_MESSAGE_URL || `${getWatiBaseUrl()}/api/v1/sendTemplateMessage`;
    const WATI_TOKEN = getWatiToken();

    if (!WATI_TOKEN) {
      console.warn("⚠️ WATI_TOKEN not configured in environment variables");
      return { success: false, error: "WATI not configured" };
    }

    // Format mobile number - ensure 10 digits without country code
    const cleanNumber = mobileNumber.toString().replace(/\D/g, "");
    const phoneNumber = cleanNumber.length === 12 && cleanNumber.startsWith("91") 
      ? cleanNumber.substring(2) 
      : cleanNumber;

    const channelNumber = process.env.WATI_CHANNEL_NUMBER || "917276386452";
    const body = {
      template_name: templateName,
      broadcast_name: `Order_${Date.now()}`,
      parameters: parameters,
      channel_number: channelNumber,
    };

    console.log(`📤 Sending WATI message to ${phoneNumber} using template: ${templateName}`);

    const response = await fetch(
      `${WATI_URL}?whatsappNumber=91${phoneNumber}`,
      {
        method: "POST",
        body: JSON.stringify(body),
        headers: {
          "Content-Type": "application/json",
          Authorization: WATI_TOKEN,
        },
        timeout: 10000, // 10 second timeout
      }
    );

    const data = await response.json();

    if (response.ok) {
      console.log(`✅ WATI message sent successfully to ${phoneNumber}`);
      return { success: true, data };
    } else {
      console.error(`❌ WATI API error:`, data);
      return { success: false, error: data };
    }
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
    if (!farmer || !farmer.mobileNumber) {
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
      { name: "name", value: farmer.name || "Farmer" },
      { name: "id", value: templateOrderId },
      { name: "village", value: farmer.village || "N/A" },
      { name: "number", value: farmer.mobileNumber?.toString() || "N/A" },
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
      farmer.mobileNumber,
      templateName,
      parameters
    );
  } catch (error) {
    console.error("❌ Error in sendOrderAcceptedWhatsApp:", error);
    return { success: false, error: error.message };
  }
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
      { name: "name", value: farmer.name || "Farmer" },
      { name: "id", value: details.publicOrderCode?.toString() || details.orderId?.toString() || "N/A" },
      { name: "village", value: farmer.village || "N/A" },
      { name: "plant", value: plantParam },
      { name: "subtype", value: subtypeParam },
      { name: "total_dispatched", value: (details.totalDispatched ?? "0").toString() },
      { name: "driver_name", value: details.driverName || "N/A" },
      { name: "vehicle_number", value: details.vehicleNumber || "N/A" },
      { name: "dispatch_date", value: formatIn(details.dispatchDate) },
    ];

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


import fetch from "node-fetch";

/**
 * Send WhatsApp template message via WATI API
 * @param {string} mobileNumber - Farmer's mobile number (10 digits)
 * @param {string} templateName - WATI template name
 * @param {Array} parameters - Template parameters
 * @returns {Promise<Object>} WATI API response
 */
export async function sendWatiTemplateMessage(mobileNumber, templateName, parameters = []) {
  try {
    const WATI_URL = process.env.SEND_TEMPLATE_MESSAGE_URL || "https://live-mt-server.wati.io/385403/api/v1/sendTemplateMessage";
    const WATI_TOKEN = process.env.WATI_TOKEN;

    if (!WATI_TOKEN) {
      console.warn("⚠️ WATI_TOKEN not configured in environment variables");
      return { success: false, error: "WATI not configured" };
    }

    // Format mobile number - ensure 10 digits without country code
    const cleanNumber = mobileNumber.toString().replace(/\D/g, "");
    const phoneNumber = cleanNumber.length === 12 && cleanNumber.startsWith("91") 
      ? cleanNumber.substring(2) 
      : cleanNumber;

    const body = {
      template_name: templateName,
      broadcast_name: `Order_${Date.now()}`,
      parameters: parameters,
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

    // Format delivery date
    const formattedDate = deliveryDate
      ? new Date(deliveryDate).toLocaleDateString("en-IN", {
          day: "2-digit",
          month: "2-digit",
          year: "numeric",
        })
      : "To be confirmed";

    // Parameters for WhatsApp template
    // Adjust based on your actual WATI template structure
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
      {
        name: "amount",
        value: totalAmount ? `₹${totalAmount}` : "₹0",
      },
    ];

    // Use your WATI template name for order acceptance
    // Change this to match your actual template name in WATI
    const templateName = "order_accepted"; // Update this with your actual template name

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
 * Send order ready for dispatch WhatsApp message to farmer
 * @param {Object} farmer - Farmer details
 * @param {Object} orderDetails - Order details
 * @returns {Promise<Object>} Send result
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


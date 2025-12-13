import catchAsync from "../utility/catchAsync.js";
import generateResponse from "../utility/responseFormat.js";
import { sendWatiTemplateMessage } from "../utility/watiMessaging.js";
import fetch from "node-fetch";
import Farmer from "../models/farmer.model.js";
import PlantCms from "../models/plantCms.model.js";
import PlantSlot from "../models/slots.model.js";
import moment from "moment";

const WATI_URL = process.env.WATI_URL || "https://live-mt-server.wati.io/385403";
const WATI_TOKEN = process.env.WATI_TOKEN;

// Store conversation state (in production, use Redis or database)
const conversationState = new Map();

/**
 * Send interactive message with buttons using Wati API
 */
async function sendInteractiveMessage(mobileNumber, message, buttons = []) {
  try {
    const cleanNumber = mobileNumber.toString().replace(/\D/g, "");
    const phoneNumber = cleanNumber.length === 12 && cleanNumber.startsWith("91") 
      ? cleanNumber.substring(2) 
      : cleanNumber;

    // For interactive buttons, we'll use Wati's send message API
    const url = `${WATI_URL}/api/v1/sendSessionMessage/91${phoneNumber}`;
    
    let messageBody = message;
    
    // Add buttons if provided
    if (buttons.length > 0) {
      // Format buttons for Wati (using text format for now)
      const buttonText = buttons.map((btn, idx) => `${idx + 1}. ${btn.text}`).join("\n");
      messageBody = `${message}\n\n${buttonText}`;
    }

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${WATI_TOKEN}`,
      },
      body: JSON.stringify({
        text: messageBody,
      }),
    });

    const data = await response.json();
    return { success: response.ok, data };
  } catch (error) {
    console.error("Error sending interactive message:", error);
    return { success: false, error: error.message };
  }
}

/**
 * Get or initialize conversation state
 */
function getConversationState(mobileNumber) {
  const state = conversationState.get(mobileNumber) || {
    step: "welcome",
    orderData: {
      mobileNumber: mobileNumber,
      name: "",
      state: "",
      district: "",
      taluka: "",
      village: "",
      plant: "",
      subtype: "",
      cavity: "",
      deliveryDate: "",
      noOfPlants: "",
      rate: "",
    },
    farmerData: null,
  };
  conversationState.set(mobileNumber, state);
  return state;
}

/**
 * Save conversation state
 */
function saveConversationState(mobileNumber, state) {
  conversationState.set(mobileNumber, state);
}

/**
 * Clear conversation state
 */
function clearConversationState(mobileNumber) {
  conversationState.delete(mobileNumber);
}

/**
 * Handle incoming WhatsApp webhook from Wati
 */
export const handleWhatsAppWebhook = catchAsync(async (req, res) => {
  // 🔥 RAW WATI WEBHOOK LOGGER - Logs everything before any processing
  console.log("\n🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥");
  console.log("🔥🔥 RAW WATI WEBHOOK RECEIVED 🔥🔥");
  console.log("🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥\n");
  
  // Log request method and URL
  console.log("📋 REQUEST INFO:");
  console.log(`   Method: ${req.method}`);
  console.log(`   URL: ${req.originalUrl || req.url}`);
  console.log(`   Path: ${req.path}`);
  console.log(`   IP: ${req.ip || req.connection?.remoteAddress}`);
  console.log(`   Timestamp: ${new Date().toISOString()}\n`);
  
  // Log all headers
  console.log("📨 REQUEST HEADERS:");
  console.log(JSON.stringify(req.headers, null, 2));
  console.log("");
  
  // Log raw body
  console.log("📦 REQUEST BODY:");
  if (req.body && Object.keys(req.body).length > 0) {
    console.log(JSON.stringify(req.body, null, 2));
  } else {
    console.log("   ⚠️  EMPTY BODY OR NO DATA");
    console.log(`   Body type: ${typeof req.body}`);
    console.log(`   Body keys: ${req.body ? Object.keys(req.body).join(', ') : 'null'}`);
  }
  console.log("");
  
  // Log query params
  if (req.query && Object.keys(req.query).length > 0) {
    console.log("🔍 QUERY PARAMS:");
    console.log(JSON.stringify(req.query, null, 2));
    console.log("");
  }
  
  console.log("🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥");
  console.log("🔥🔥 END RAW WEBHOOK LOG 🔥🔥");
  console.log("🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥\n");

  // Debug logging for local testing
  if (process.env.NODE_ENV !== 'production') {
    const timestamp = new Date().toISOString();
    console.log(`\n${'='.repeat(60)}`);
    console.log(`📥 [${timestamp}] Webhook Received`);
    console.log(`${'='.repeat(60)}`);
    console.log('Event:', req.body?.event);
    console.log('Data:', JSON.stringify(req.body?.data, null, 2));
    console.log(`${'='.repeat(60)}\n`);
  }

  const { event, data } = req.body;

  // Wati webhook format
  if (event === "message" && data) {
    const { waId, text, buttonText } = data;
    const mobileNumber = waId?.replace("91", "") || data.from?.replace("91", "");

    if (!mobileNumber) {
      return res.status(200).json({ success: true });
    }

    const userMessage = buttonText || text?.body || "";
    const state = getConversationState(mobileNumber);

    // Process the message based on current step
    await processOrderFlow(mobileNumber, userMessage, state);

    return res.status(200).json({ success: true });
  }

  res.status(200).json({ success: true });
});

/**
 * Main order flow processor
 */
async function processOrderFlow(mobileNumber, userMessage, state) {
  const message = userMessage.trim().toLowerCase();

  // Debug logging
  if (process.env.NODE_ENV !== 'production') {
    console.log(`🔄 Processing order flow for: ${mobileNumber}`);
    console.log(`📝 Message: "${userMessage}"`);
    console.log(`📍 Current step: ${state.step}`);
  }

  try {
    switch (state.step) {
      case "welcome":
        await handleWelcome(mobileNumber, state);
        break;

      case "order_confirmation":
        await handleOrderConfirmation(mobileNumber, message, state);
        break;

      case "mobile_verification":
        await handleMobileVerification(mobileNumber, message, state);
        break;

      case "farmer_name":
        await handleFarmerName(mobileNumber, message, state);
        break;

      case "state_selection":
        await handleStateSelection(mobileNumber, message, state);
        break;

      case "district_selection":
        await handleDistrictSelection(mobileNumber, message, state);
        break;

      case "taluka_selection":
        await handleTalukaSelection(mobileNumber, message, state);
        break;

      case "village_selection":
        await handleVillageSelection(mobileNumber, message, state);
        break;

      case "plant_selection":
        await handlePlantSelection(mobileNumber, message, state);
        break;

      case "subtype_selection":
        await handleSubtypeSelection(mobileNumber, message, state);
        break;

      case "cavity_selection":
        await handleCavitySelection(mobileNumber, message, state);
        break;

      case "delivery_date":
        await handleDeliveryDate(mobileNumber, message, state);
        break;

      case "quantity":
        await handleQuantity(mobileNumber, message, state);
        break;

      case "confirmation":
        await handleConfirmation(mobileNumber, message, state);
        break;

      default:
        await sendInteractiveMessage(
          mobileNumber,
          "I didn't understand that. Please type 'ORDER' to start a new order."
        );
    }
  } catch (error) {
    console.error("Error in order flow:", error);
    await sendInteractiveMessage(
      mobileNumber,
      "Sorry, an error occurred. Please type 'ORDER' to start again."
    );
    clearConversationState(mobileNumber);
  }
}

/**
 * Welcome step - Start order flow
 */
async function handleWelcome(mobileNumber, state) {
  // Check if farmer exists
  const farmer = await Farmer.findOne({ mobileNumber: parseInt(mobileNumber) });

  if (farmer) {
    state.farmerData = farmer;
    state.orderData.name = farmer.name;
    state.orderData.state = farmer.state || farmer.stateName || "Maharashtra";
    state.orderData.district = farmer.district || farmer.districtName || "";
    state.orderData.taluka = farmer.taluka || farmer.talukaName || "";
    state.orderData.village = farmer.village || "";

    await sendInteractiveMessage(
      mobileNumber,
      `👋 Hello ${farmer.name}!\n\nWelcome to Nursery Order System.\n\nYour details:\n📍 ${farmer.village}, ${farmer.talukaName || farmer.taluka}, ${farmer.districtName || farmer.district}\n\nWould you like to place an order?`,
      [
        { text: "Yes, Place Order", value: "yes" },
        { text: "No, Cancel", value: "no" },
      ]
    );
    state.step = "order_confirmation";
  } else {
    await sendInteractiveMessage(
      mobileNumber,
      "👋 Welcome to Nursery Order System!\n\nTo place an order, I need some information.\n\nPlease enter your 10-digit mobile number:",
      []
    );
    state.step = "mobile_verification";
  }
  saveConversationState(mobileNumber, state);
}

/**
 * Order confirmation for existing farmers
 */
async function handleOrderConfirmation(mobileNumber, message, state) {
  if (message === "yes" || message === "1") {
    state.step = "plant_selection";
    await loadPlants(mobileNumber, state);
  } else {
    await sendInteractiveMessage(mobileNumber, "Order cancelled. Type 'ORDER' anytime to start again.");
    clearConversationState(mobileNumber);
  }
  saveConversationState(mobileNumber, state);
}

/**
 * Mobile verification step
 */
async function handleMobileVerification(mobileNumber, message, state) {
  const cleanMobile = message.replace(/\D/g, "");
  if (cleanMobile.length === 10) {
    const farmer = await Farmer.findOne({ mobileNumber: parseInt(cleanMobile) });
    if (farmer) {
      state.farmerData = farmer;
      state.orderData.mobileNumber = cleanMobile;
      state.orderData.name = farmer.name;
      state.orderData.state = farmer.state || farmer.stateName || "Maharashtra";
      state.orderData.district = farmer.district || farmer.districtName || "";
      state.orderData.taluka = farmer.taluka || farmer.talukaName || "";
      state.orderData.village = farmer.village || "";

      await sendInteractiveMessage(
        mobileNumber,
        `✅ Found your account!\n\nName: ${farmer.name}\nLocation: ${farmer.village}, ${farmer.talukaName || farmer.taluka}\n\nLet's proceed with your order.`,
        []
      );
      state.step = "plant_selection";
      await loadPlants(mobileNumber, state);
    } else {
      await sendInteractiveMessage(
        mobileNumber,
        "Mobile number not found. Please enter your name:",
        []
      );
      state.orderData.mobileNumber = cleanMobile;
      state.step = "farmer_name";
    }
  } else {
    await sendInteractiveMessage(
      mobileNumber,
      "❌ Invalid mobile number. Please enter a valid 10-digit number:",
      []
    );
  }
  saveConversationState(mobileNumber, state);
}

/**
 * Farmer name step
 */
async function handleFarmerName(mobileNumber, message, state) {
  if (message.length >= 2) {
    state.orderData.name = message;
    await sendInteractiveMessage(
      mobileNumber,
      `✅ Name saved: ${message}\n\nNow, please select your State:`,
      []
    );
    state.step = "state_selection";
    await loadStates(mobileNumber, state);
  } else {
    await sendInteractiveMessage(
      mobileNumber,
      "❌ Name too short. Please enter your full name:",
      []
    );
  }
  saveConversationState(mobileNumber, state);
}

/**
 * Load and send states
 */
async function loadStates(mobileNumber, state) {
  // Get unique states from farmers or use predefined list
  const states = ["Maharashtra", "Gujarat", "Karnataka"];
  
  let message = "Please select your State:\n\n";
  states.forEach((stateName, idx) => {
    message += `${idx + 1}. ${stateName}\n`;
  });

  await sendInteractiveMessage(mobileNumber, message, []);
}

/**
 * State selection step
 */
async function handleStateSelection(mobileNumber, message, state) {
  const states = ["Maharashtra", "Gujarat", "Karnataka"];
  const selectedIdx = parseInt(message) - 1;

  if (selectedIdx >= 0 && selectedIdx < states.length) {
    state.orderData.state = states[selectedIdx];
    await sendInteractiveMessage(
      mobileNumber,
      `✅ State: ${states[selectedIdx]}\n\nPlease enter your District:`,
      []
    );
    state.step = "district_selection";
  } else {
    await sendInteractiveMessage(mobileNumber, "❌ Invalid selection. Please try again:", []);
    await loadStates(mobileNumber, state);
  }
  saveConversationState(mobileNumber, state);
}

/**
 * District selection step
 */
async function handleDistrictSelection(mobileNumber, message, state) {
  if (message.length >= 2) {
    state.orderData.district = message;
    await sendInteractiveMessage(
      mobileNumber,
      `✅ District: ${message}\n\nPlease enter your Taluka:`,
      []
    );
    state.step = "taluka_selection";
  } else {
    await sendInteractiveMessage(mobileNumber, "❌ Please enter a valid district name:", []);
  }
  saveConversationState(mobileNumber, state);
}

/**
 * Taluka selection step
 */
async function handleTalukaSelection(mobileNumber, message, state) {
  if (message.length >= 2) {
    state.orderData.taluka = message;
    await sendInteractiveMessage(
      mobileNumber,
      `✅ Taluka: ${message}\n\nPlease enter your Village:`,
      []
    );
    state.step = "village_selection";
  } else {
    await sendInteractiveMessage(mobileNumber, "❌ Please enter a valid taluka name:", []);
  }
  saveConversationState(mobileNumber, state);
}

/**
 * Village selection step
 */
async function handleVillageSelection(mobileNumber, message, state) {
  if (message.length >= 2) {
    state.orderData.village = message;
    await sendInteractiveMessage(
      mobileNumber,
      `✅ Village: ${message}\n\nGreat! Now let's select your plant.`,
      []
    );
    state.step = "plant_selection";
    await loadPlants(mobileNumber, state);
  } else {
    await sendInteractiveMessage(mobileNumber, "❌ Please enter a valid village name:", []);
  }
  saveConversationState(mobileNumber, state);
}

/**
 * Load and send available plants
 */
async function loadPlants(mobileNumber, state) {
  try {
    const plants = await PlantCms.find({}).select("name _id").limit(10);
    
    if (plants.length === 0) {
      await sendInteractiveMessage(mobileNumber, "❌ No plants available at the moment.");
      clearConversationState(mobileNumber);
      return;
    }

    let message = "🌱 Please select a Plant:\n\n";
    plants.forEach((plant, idx) => {
      message += `${idx + 1}. ${plant.name}\n`;
      state.plantsList = state.plantsList || [];
      state.plantsList[idx] = plant._id.toString();
    });

    await sendInteractiveMessage(mobileNumber, message, []);
  } catch (error) {
    console.error("Error loading plants:", error);
    await sendInteractiveMessage(mobileNumber, "❌ Error loading plants. Please try again later.");
  }
}

/**
 * Plant selection step
 */
async function handlePlantSelection(mobileNumber, message, state) {
  if (!state.plantsList) {
    await loadPlants(mobileNumber, state);
    return;
  }

  const selectedIdx = parseInt(message) - 1;
  if (selectedIdx >= 0 && selectedIdx < state.plantsList.length) {
    state.orderData.plant = state.plantsList[selectedIdx];
    const plant = await PlantCms.findById(state.plantsList[selectedIdx]);
    
    await sendInteractiveMessage(
      mobileNumber,
      `✅ Plant: ${plant.name}\n\nLoading subtypes...`,
      []
    );
    state.step = "subtype_selection";
    await loadSubtypes(mobileNumber, state);
  } else {
    await sendInteractiveMessage(mobileNumber, "❌ Invalid selection. Please try again:", []);
    await loadPlants(mobileNumber, state);
  }
  saveConversationState(mobileNumber, state);
}

/**
 * Load and send subtypes
 */
async function loadSubtypes(mobileNumber, state) {
  try {
    const plant = await PlantCms.findById(state.orderData.plant).select("subtypes");
    
    if (!plant || !plant.subtypes || plant.subtypes.length === 0) {
      await sendInteractiveMessage(mobileNumber, "❌ No subtypes available for this plant.");
      state.step = "plant_selection";
      await loadPlants(mobileNumber, state);
      return;
    }

    let message = "🌿 Please select a Subtype:\n\n";
    plant.subtypes.forEach((subtype, idx) => {
      // Get the first rate from rates array, or default to 0
      const rate = subtype.rates && subtype.rates.length > 0 ? subtype.rates[0] : 0;
      message += `${idx + 1}. ${subtype.name} (₹${rate})\n`;
      state.subtypesList = state.subtypesList || [];
      state.subtypesList[idx] = { id: subtype._id.toString(), rate: rate };
    });

    await sendInteractiveMessage(mobileNumber, message, []);
  } catch (error) {
    console.error("Error loading subtypes:", error);
    await sendInteractiveMessage(mobileNumber, "❌ Error loading subtypes. Please try again.");
  }
}

/**
 * Subtype selection step
 */
async function handleSubtypeSelection(mobileNumber, message, state) {
  if (!state.subtypesList) {
    await loadSubtypes(mobileNumber, state);
    return;
  }

  const selectedIdx = parseInt(message) - 1;
  if (selectedIdx >= 0 && selectedIdx < state.subtypesList.length) {
    state.orderData.subtype = state.subtypesList[selectedIdx].id;
    state.orderData.rate = state.subtypesList[selectedIdx].rate;
    
    // Get subtype name from plant document
    const plant = await PlantCms.findById(state.orderData.plant).select("subtypes");
    const subtype = plant.subtypes.find(s => s._id.toString() === state.subtypesList[selectedIdx].id);
    
    await sendInteractiveMessage(
      mobileNumber,
      `✅ Subtype: ${subtype.name}\nRate: ₹${state.orderData.rate}\n\nPlease select Cavity:\n\n1. 50\n2. 100\n3. 200`,
      []
    );
    state.step = "cavity_selection";
  } else {
    await sendInteractiveMessage(mobileNumber, "❌ Invalid selection. Please try again:", []);
    await loadSubtypes(mobileNumber, state);
  }
  saveConversationState(mobileNumber, state);
}

/**
 * Cavity selection step
 */
async function handleCavitySelection(mobileNumber, message, state) {
  const cavities = ["50", "100", "200"];
  const selectedIdx = parseInt(message) - 1;

  if (selectedIdx >= 0 && selectedIdx < cavities.length) {
    state.orderData.cavity = cavities[selectedIdx];
    await sendInteractiveMessage(
      mobileNumber,
      `✅ Cavity: ${cavities[selectedIdx]}\n\nLoading available delivery dates...`,
      []
    );
    state.step = "delivery_date";
    await loadDeliveryDates(mobileNumber, state);
  } else {
    await sendInteractiveMessage(mobileNumber, "❌ Invalid selection. Please select 1, 2, or 3:", []);
  }
  saveConversationState(mobileNumber, state);
}

/**
 * Load and send available delivery dates
 */
async function loadDeliveryDates(mobileNumber, state) {
  try {
    const slots = await PlantSlot.find({
      plantId: state.orderData.plant,
      subtypeId: state.orderData.subtype,
      availableQuantity: { $gt: 0 },
    })
      .sort({ startDay: 1 })
      .limit(5)
      .select("startDay endDay availableQuantity _id");

    if (slots.length === 0) {
      await sendInteractiveMessage(
        mobileNumber,
        "❌ No delivery slots available. Please try a different plant/subtype."
      );
      state.step = "plant_selection";
      await loadPlants(mobileNumber, state);
      return;
    }

    let message = "📅 Please select Delivery Date:\n\n";
    slots.forEach((slot, idx) => {
      message += `${idx + 1}. ${slot.startDay} to ${slot.endDay} (Available: ${slot.availableQuantity})\n`;
      state.slotsList = state.slotsList || [];
      state.slotsList[idx] = {
        id: slot._id.toString(),
        startDay: slot.startDay,
        endDay: slot.endDay,
      };
    });

    await sendInteractiveMessage(mobileNumber, message, []);
  } catch (error) {
    console.error("Error loading slots:", error);
    await sendInteractiveMessage(mobileNumber, "❌ Error loading delivery dates. Please try again.");
  }
}

/**
 * Delivery date selection step
 */
async function handleDeliveryDate(mobileNumber, message, state) {
  if (!state.slotsList) {
    await loadDeliveryDates(mobileNumber, state);
    return;
  }

  const selectedIdx = parseInt(message) - 1;
  if (selectedIdx >= 0 && selectedIdx < state.slotsList.length) {
    const slot = state.slotsList[selectedIdx];
    state.orderData.deliveryDate = slot.startDay; // Use start day as delivery date
    state.orderData.slotId = slot.id;

    await sendInteractiveMessage(
      mobileNumber,
      `✅ Delivery Date: ${slot.startDay} to ${slot.endDay}\n\nPlease enter number of plants:`,
      []
    );
    state.step = "quantity";
  } else {
    await sendInteractiveMessage(mobileNumber, "❌ Invalid selection. Please try again:", []);
    await loadDeliveryDates(mobileNumber, state);
  }
  saveConversationState(mobileNumber, state);
}

/**
 * Quantity step
 */
async function handleQuantity(mobileNumber, message, state) {
  const quantity = parseInt(message);
  if (quantity > 0 && quantity <= 10000) {
    state.orderData.noOfPlants = quantity.toString();
    
    const totalAmount = quantity * parseFloat(state.orderData.rate);
    
    // Show order summary
    const plant = await PlantCms.findById(state.orderData.plant).select("name subtypes");
    const subtype = plant.subtypes.find(s => s._id.toString() === state.orderData.subtype);
    
    const summary = `
📋 *Order Summary:*

👤 Name: ${state.orderData.name}
📱 Mobile: ${state.orderData.mobileNumber}
📍 Location: ${state.orderData.village}, ${state.orderData.taluka}, ${state.orderData.district}

🌱 Plant: ${plant.name}
🌿 Subtype: ${subtype.name}
🕳️ Cavity: ${state.orderData.cavity}
📅 Delivery: ${state.orderData.deliveryDate}
📦 Quantity: ${quantity} plants
💰 Rate: ₹${state.orderData.rate}/plant
💵 Total: ₹${totalAmount}

Please confirm:
1. ✅ Confirm Order
2. ❌ Cancel
    `;

    await sendInteractiveMessage(mobileNumber, summary, []);
    state.step = "confirmation";
  } else {
    await sendInteractiveMessage(
      mobileNumber,
      "❌ Invalid quantity. Please enter a number between 1 and 10000:",
      []
    );
  }
  saveConversationState(mobileNumber, state);
}

/**
 * Confirmation step - Create order
 */
async function handleConfirmation(mobileNumber, message, state) {
  if (message === "1" || message === "confirm" || message === "yes") {
    await sendInteractiveMessage(
      mobileNumber,
      "⏳ Processing your order... Please wait.",
      []
    );

    try {
      // Prepare order payload (similar to AddOrderFormScreen)
      const orderPayload = {
        name: state.orderData.name,
        mobileNumber: state.orderData.mobileNumber,
        village: state.orderData.village,
        taluka: state.orderData.taluka,
        district: state.orderData.district,
        state: state.orderData.state,
        stateName: state.orderData.state,
        districtName: state.orderData.district,
        talukaName: state.orderData.taluka,
        typeOfPlants: "",
        numberOfPlants: parseInt(state.orderData.noOfPlants),
        rate: parseFloat(state.orderData.rate),
        paymentStatus: "not paid",
        orderStatus: "PENDING",
        plantName: state.orderData.plant,
        plantSubtype: state.orderData.subtype,
        bookingSlot: state.orderData.slotId,
        deliveryDate: new Date().toISOString(), // Will be set properly
        orderPaymentStatus: "PENDING",
        cavity: parseInt(state.orderData.cavity),
        orderBookingDate: new Date().toISOString(),
      };

      // Create order using internal API call to existing endpoint
      // This mimics the AddOrderFormScreen flow
      const API_BASE_URL = process.env.API_BASE_URL || "http://localhost:8000";
      const orderResponse = await fetch(`${API_BASE_URL}/api/v1/farmer/createFarmer`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          // Note: For WhatsApp orders, you may need a system user token
          // Or create a special endpoint that doesn't require auth
        },
        body: JSON.stringify(orderPayload),
      });

      const orderResult = await orderResponse.json();

      if (orderResult.success) {
        await sendInteractiveMessage(
          mobileNumber,
          `✅ *Order Placed Successfully!*\n\nOrder ID: ${orderResult.orderId}\n\nYour order has been received and will be processed soon.\n\nThank you for your order! 🙏`,
          []
        );
        clearConversationState(mobileNumber);
      } else {
        throw new Error("Order creation failed");
      }
    } catch (error) {
      console.error("Error creating order:", error);
      await sendInteractiveMessage(
        mobileNumber,
        "❌ Sorry, there was an error processing your order. Please try again or contact support.",
        []
      );
      clearConversationState(mobileNumber);
    }
  } else {
    await sendInteractiveMessage(mobileNumber, "Order cancelled. Type 'ORDER' to start again.");
    clearConversationState(mobileNumber);
  }
}

/**
 * Health check endpoint for webhook (GET request)
 */
export const webhookHealthCheck = catchAsync(async (req, res) => {
  return res.status(200).json(
    generateResponse("success", "WhatsApp webhook endpoint is active", {
      endpoint: "/api/v1/whatsapp-order/webhook",
      method: "POST",
      status: "ready",
      timestamp: new Date().toISOString(),
    })
  );
});

/**
 * Manual trigger to start order flow (for testing)
 */
export const startOrderFlow = catchAsync(async (req, res) => {
  const { mobileNumber } = req.body;

  if (!mobileNumber) {
    return res.status(400).json(
      generateResponse("error", "Mobile number is required", null)
    );
  }

  const state = getConversationState(mobileNumber);
  state.step = "welcome";
  saveConversationState(mobileNumber, state);

  await handleWelcome(mobileNumber, state);

  return res.status(200).json(
    generateResponse("success", "Order flow started", { mobileNumber })
  );
});


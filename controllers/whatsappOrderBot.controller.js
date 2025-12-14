import catchAsync from "../utility/catchAsync.js";
import generateResponse from "../utility/responseFormat.js";
import fetch from "node-fetch";
import Farmer from "../models/farmer.model.js";
import PlantCms from "../models/plantCms.model.js";
import PlantSlot from "../models/slots.model.js";
import { getWatiBaseUrl, getWatiToken } from "../config/wati.config.js";

const WATI_BASE_URL = getWatiBaseUrl();
const WATI_TOKEN = getWatiToken();

// Admin phone number for notifications (from env or default)
const ADMIN_PHONE = process.env.ADMIN_PHONE || "7588686452";

// Store conversation state (in production, use Redis or database)
const conversationState = new Map();

/**
 * Send simple WhatsApp message using Wati API
 * @param {string} phone - Phone number (with or without country code)
 * @param {string} text - Message text to send
 * @returns {Promise<Object>} Send result
 */
async function sendWhatsAppMessage(phone, text) {
  try {
    if (!WATI_TOKEN) {
      console.error("❌ WATI_TOKEN not configured");
      return { success: false, error: "WATI_TOKEN not configured" };
    }

    // Clean and format phone number
    const cleanNumber = phone.toString().replace(/\D/g, "");
    const phoneNumber = cleanNumber.length === 12 && cleanNumber.startsWith("91") 
      ? cleanNumber.substring(2) 
      : cleanNumber;

    const url = `${WATI_BASE_URL}/api/v1/sendSessionMessage/91${phoneNumber}`;
    
    console.log("📤 Sending WATI message to:", phoneNumber);
    console.log("📤 Message:", text);
    
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "Authorization": `Bearer ${WATI_TOKEN}`,
      },
      body: JSON.stringify({
        message: text,
      }),
    });

    const data = await response.json();
    console.log("📤 WATI RESPONSE:", data);
    
    if (response.ok) {
      return { success: true, data };
    } else {
      console.error("❌ WATI API error:", data);
      return { success: false, error: data };
    }
  } catch (error) {
    console.error("❌ Error sending WhatsApp message:", error.message);
    return { success: false, error: error.message };
  }
}

/**
 * Send admin notification about new order
 */
async function sendAdminNotification(orderData) {
  console.log("\n📤 [NOTIFICATION] Preparing admin notification...");
  console.log(`   📱 Admin phone: ${ADMIN_PHONE}`);
  console.log(`   📋 Order data:`, JSON.stringify(orderData, null, 2));
  
  try {
    const message = `📦 *New WhatsApp Order*

👤 Customer: ${orderData.customerName || "Unknown"}
📱 Phone: ${orderData.mobileNumber}
🌱 Plant: ${orderData.plantName}
🍃 Variety: ${orderData.varietyName}
📦 Cavity: ${orderData.cavity}
🔢 Quantity: ${orderData.quantity}
💵 Amount: ₹${orderData.total}
📅 Delivery: ${orderData.deliveryDate}
🧾 Order ID: ${orderData.orderId || "Processing..."}`;

    console.log("   📝 Notification message prepared");
    await sendWhatsAppMessage(ADMIN_PHONE, message);
    console.log("   ✅ Admin notification sent successfully");
  } catch (error) {
    console.error("   ❌ Error sending admin notification:", error);
    console.error("   Stack:", error.stack);
    // Don't fail order creation if notification fails
  }
}

/**
 * Get or initialize conversation state
 */
function getConversationState(mobileNumber) {
  console.log(`\n📂 [STATE] Getting conversation state for: ${mobileNumber}`);
  const existingState = conversationState.get(mobileNumber);
  
  if (existingState) {
    console.log(`   ✅ Found existing state - Step: ${existingState.step}`);
    console.log(`   📋 Order data:`, JSON.stringify(existingState.order, null, 2));
    return existingState;
  }
  
  console.log(`   🆕 Creating new state - Step: MAIN_MENU`);
  const newState = {
    step: "MAIN_MENU",
    order: {
      plant: null,
      plantName: "",
      variety: null,
      varietyName: "",
      rate: 0,
      cavity: null,
      quantity: null,
      deliveryDate: "",
      slotId: null,
      total: 0,
    },
    lists: {
      plants: [],
      varieties: [],
      slots: [],
    },
  };
  conversationState.set(mobileNumber, newState);
  console.log(`   ✅ New state created and saved\n`);
  return newState;
}

/**
 * Save conversation state
 */
function saveConversationState(mobileNumber, state) {
  console.log(`\n💾 [STATE] Saving state for: ${mobileNumber}`);
  console.log(`   📍 Step: ${state.step}`);
  console.log(`   📋 Order:`, JSON.stringify(state.order, null, 2));
  conversationState.set(mobileNumber, state);
  console.log(`   ✅ State saved\n`);
}

/**
 * Clear conversation state
 */
function clearConversationState(mobileNumber) {
  console.log(`\n🗑️  [STATE] Clearing state for: ${mobileNumber}`);
  conversationState.delete(mobileNumber);
  console.log(`   ✅ State cleared\n`);
}

/**
 * Handle incoming WhatsApp webhook from Wati
 */
export const handleWhatsAppWebhook = catchAsync(async (req, res) => {
  // 🔥 RAW WATI WEBHOOK LOGGER
  console.log("\n🔥🔥🔥 RAW WATI WEBHOOK RECEIVED 🔥🔥🔥\n");
  console.log("📋 REQUEST INFO:");
  console.log(`   Method: ${req.method}`);
  console.log(`   URL: ${req.originalUrl || req.url}`);
  console.log(`   Timestamp: ${new Date().toISOString()}\n`);
  
  console.log("📦 REQUEST BODY:");
  if (req.body && Object.keys(req.body).length > 0) {
    console.log(JSON.stringify(req.body, null, 2));
  } else {
    console.log("   ⚠️  EMPTY BODY");
  }
  console.log("");

  // Support multiple webhook formats
  let message = null;
  let phone = null;
  let mobileNumber = null;
  let senderName = null;

  // Format 1: New format (eventType, type, text, waId, senderName)
  if (req.body?.eventType === "message" && req.body?.waId) {
    message = req.body.text || "";
    phone = req.body.waId;
    senderName = req.body.senderName || "";
    mobileNumber = phone.replace(/^91/, "") || phone;
    console.log("📩 Format 1 - New format detected");
    console.log(`   Phone: ${phone}, Message: ${message}, Sender: ${senderName}`);
  }
  // Format 2: Direct format (req.body.text, req.body.waId)
  else if (req.body?.text && req.body?.waId) {
    message = req.body.text;
    phone = req.body.waId;
    mobileNumber = phone.replace(/^91/, "") || phone;
    console.log("📩 Format 2 - Direct format detected");
  }
  // Format 3: Nested Wati format (req.body.event, req.body.data)
  else if (req.body?.event === "message" && req.body?.data) {
    const { waId, text, buttonText } = req.body.data;
    phone = waId || req.body.data.from;
    mobileNumber = phone?.replace(/^91/, "") || phone;
    message = buttonText || text?.body || text || "";
    console.log("📩 Format 3 - Nested Wati format detected");
  }
  // Format 4: Simple nested (req.body.data.text, req.body.data.waId)
  else if (req.body?.data?.text && req.body?.data?.waId) {
    message = req.body.data.text;
    phone = req.body.data.waId;
    mobileNumber = phone.replace(/^91/, "") || phone;
    console.log("📩 Format 4 - Simple nested format detected");
  }

  // If no message or phone, return success (webhook received but not a message)
  if (!message || !phone) {
    console.log("⚠️  No message or phone found in webhook payload");
    return res.status(200).json({ success: true });
  }

  console.log("\n" + "=".repeat(60));
  console.log("📩 [WEBHOOK] Incoming WhatsApp Message");
  console.log("=".repeat(60));
  console.log(`   📱 Phone: ${phone}`);
  console.log(`   📝 Message: "${message}"`);
  console.log(`   👤 Sender: ${senderName || "Unknown"}`);
  console.log(`   🔢 Clean Mobile: ${mobileNumber}`);
  console.log("=".repeat(60) + "\n");

  // Process the message through order flow
  console.log("🔄 [FLOW] Starting order flow processing...");
  const state = getConversationState(mobileNumber);
  await processOrderFlow(mobileNumber, message, state, senderName);
  console.log("✅ [FLOW] Order flow processing completed\n");

  console.log("📤 [RESPONSE] Sending 200 OK to WATI");
  return res.status(200).json({ success: true });
});

/**
 * Main order flow processor
 */
async function processOrderFlow(mobileNumber, userMessage, state, senderName = "") {
  const message = userMessage.trim().toLowerCase();

  console.log("\n" + "─".repeat(60));
  console.log("🔄 [PROCESS] Processing Order Flow");
  console.log("─".repeat(60));
  console.log(`   📱 Mobile: ${mobileNumber}`);
  console.log(`   📝 User Message: "${userMessage}"`);
  console.log(`   📝 Normalized: "${message}"`);
  console.log(`   📍 Current Step: ${state.step}`);
  console.log(`   👤 Sender Name: ${senderName || "Unknown"}`);
  console.log("─".repeat(60));

  // Global commands (work at any step)
  if (message === "cancel" || message === "0") {
    console.log("   🛑 [COMMAND] CANCEL detected");
    await sendWhatsAppMessage(mobileNumber, "❌ Order cancelled.\n\nType HI to start again.");
    clearConversationState(mobileNumber);
    return;
  }

  if (message === "help") {
    console.log("   ❓ [COMMAND] HELP detected");
    await sendWhatsAppMessage(
      mobileNumber,
      "📖 *Help*\n\n• Type HI to start\n• Type CANCEL to cancel anytime\n• Type MENU to go to main menu\n• Reply with numbers to select options"
    );
    return;
  }

  if (message === "menu") {
    console.log("   📋 [COMMAND] MENU detected");
    state.step = "MAIN_MENU";
    saveConversationState(mobileNumber, state);
    await handleMainMenu(mobileNumber, state);
    return;
  }

  try {
    console.log(`\n   🎯 [ROUTING] Routing to handler for step: ${state.step}`);
    switch (state.step) {
      case "MAIN_MENU":
        console.log("   → Calling handleMainMenu()");
        await handleMainMenu(mobileNumber, state, message);
        break;

      case "SELECT_PLANT":
        console.log("   → Calling handlePlantSelection()");
        await handlePlantSelection(mobileNumber, message, state);
        break;

      case "SELECT_VARIETY":
        console.log("   → Calling handleVarietySelection()");
        await handleVarietySelection(mobileNumber, message, state);
        break;

      case "SELECT_CAVITY":
        console.log("   → Calling handleCavitySelection()");
        await handleCavitySelection(mobileNumber, message, state);
        break;

      case "ENTER_QUANTITY":
        console.log("   → Calling handleQuantity()");
        await handleQuantity(mobileNumber, message, state);
        break;

      case "SELECT_DATE":
        console.log("   → Calling handleDateSelection()");
        await handleDateSelection(mobileNumber, message, state);
        break;

      case "CONFIRM_ORDER":
        console.log("   → Calling handleConfirmation()");
        await handleConfirmation(mobileNumber, message, state);
        break;

      default:
        console.log(`   ⚠️  [WARNING] Unknown step: ${state.step}`);
        await sendWhatsAppMessage(
          mobileNumber,
          "I didn't understand that. Please type 'HI' to start."
        );
        state.step = "MAIN_MENU";
        saveConversationState(mobileNumber, state);
    }
    console.log("   ✅ [ROUTING] Handler completed\n");
  } catch (error) {
    console.error("\n❌ [ERROR] Error in order flow:", error);
    console.error("   Stack:", error.stack);
    await sendWhatsAppMessage(
      mobileNumber,
      "Sorry, an error occurred. Please type 'HI' to start again."
    );
    clearConversationState(mobileNumber);
  }
}

/**
 * STEP 0: Main Menu (Greeting)
 */
async function handleMainMenu(mobileNumber, state, message = "") {
  console.log("\n📋 [STEP] MAIN_MENU Handler");
  console.log(`   📝 Input: "${message}"`);
  
  const messageLower = message.toLowerCase().trim();

  // Trigger words: hi, hello, start, or option 1
  if (messageLower === "hi" || messageLower === "hello" || messageLower === "start" || messageLower === "1") {
    console.log("   ✅ Trigger word detected - Showing welcome menu");
    await sendWhatsAppMessage(
      mobileNumber,
      `👋 Hello!\n\nWelcome to Nursery Order System 🌱\n\nPlease choose an option:\n\n1️⃣ New Order\n2️⃣ My Orders\n3️⃣ Help`
    );
    state.step = "MAIN_MENU";
    saveConversationState(mobileNumber, state);
    return;
  }

  // Handle menu selection
  if (messageLower === "1" || messageLower === "new order") {
    console.log("   ✅ Option 1 selected - Starting new order");
    state.step = "SELECT_PLANT";
    saveConversationState(mobileNumber, state);
    await loadPlants(mobileNumber, state);
  } else if (messageLower === "2" || messageLower === "my orders") {
    console.log("   ✅ Option 2 selected - My Orders");
    await sendWhatsAppMessage(
      mobileNumber,
      "📋 *My Orders*\n\nThis feature is coming soon!\n\nType HI to place a new order."
    );
  } else if (messageLower === "3" || messageLower === "help") {
    console.log("   ✅ Option 3 selected - Help");
    await sendWhatsAppMessage(
      mobileNumber,
      "📖 *Help*\n\n• Type HI to start\n• Type CANCEL to cancel anytime\n• Type MENU to go to main menu\n• Reply with numbers to select options"
    );
  } else {
    // Default: show main menu
    console.log("   ℹ️  Default action - Showing main menu");
    await sendWhatsAppMessage(
      mobileNumber,
      `👋 Hello!\n\nWelcome to Nursery Order System 🌱\n\nPlease choose an option:\n\n1️⃣ New Order\n2️⃣ My Orders\n3️⃣ Help`
    );
  }
  saveConversationState(mobileNumber, state);
  console.log("   ✅ MAIN_MENU handler completed\n");
}

/**
 * Load and send available plants
 */
async function loadPlants(mobileNumber, state) {
  console.log("\n🌱 [LOAD] Loading plants from database...");
  try {
    const plants = await PlantCms.find({}).select("name _id").limit(10);
    console.log(`   📊 Found ${plants.length} plants`);
    
    if (plants.length === 0) {
      console.log("   ⚠️  No plants found");
      await sendWhatsAppMessage(mobileNumber, "❌ No plants available at the moment.");
      state.step = "MAIN_MENU";
      saveConversationState(mobileNumber, state);
      return;
    }

    let message = "🌱 Select Plant:\n\n";
    state.lists.plants = [];
    plants.forEach((plant, idx) => {
      message += `${idx + 1}️⃣ ${plant.name}\n`;
      state.lists.plants[idx] = {
        id: plant._id.toString(),
        name: plant.name,
      };
      console.log(`   ${idx + 1}. ${plant.name} (ID: ${plant._id})`);
    });
    message += "\nReply with number";

    console.log("   ✅ Plants loaded, sending to user");
    await sendWhatsAppMessage(mobileNumber, message);
    console.log("   ✅ Plants message sent\n");
  } catch (error) {
    console.error("   ❌ Error loading plants:", error);
    console.error("   Stack:", error.stack);
    await sendWhatsAppMessage(mobileNumber, "❌ Error loading plants. Please try again later.");
    state.step = "MAIN_MENU";
    saveConversationState(mobileNumber, state);
  }
}

/**
 * STEP 2: Select Plant
 */
async function handlePlantSelection(mobileNumber, message, state) {
  console.log("\n🌱 [STEP] SELECT_PLANT Handler");
  console.log(`   📝 User input: "${message}"`);
  
  if (!state.lists.plants || state.lists.plants.length === 0) {
    console.log("   ⚠️  Plants list empty, reloading...");
    await loadPlants(mobileNumber, state);
    return;
  }

  const selectedIdx = parseInt(message) - 1;
  console.log(`   🔢 Parsed index: ${selectedIdx} (from input "${message}")`);
  console.log(`   📊 Available plants: ${state.lists.plants.length}`);
  
  if (selectedIdx >= 0 && selectedIdx < state.lists.plants.length) {
    const selectedPlant = state.lists.plants[selectedIdx];
    console.log(`   ✅ Valid selection: ${selectedPlant.name} (ID: ${selectedPlant.id})`);
    
    state.order.plant = selectedPlant.id;
    state.order.plantName = selectedPlant.name;
    console.log(`   💾 Updated order.plant: ${state.order.plant}`);
    console.log(`   💾 Updated order.plantName: ${state.order.plantName}`);
    
    await sendWhatsAppMessage(
      mobileNumber,
      `✅ Plant: ${selectedPlant.name}\n\nLoading varieties...`
    );
    state.step = "SELECT_VARIETY";
    saveConversationState(mobileNumber, state);
    await loadVarieties(mobileNumber, state);
  } else {
    console.log(`   ❌ Invalid selection (index ${selectedIdx} out of range)`);
    await sendWhatsAppMessage(mobileNumber, "❌ Invalid selection. Please try again:");
    await loadPlants(mobileNumber, state);
  }
  saveConversationState(mobileNumber, state);
  console.log("   ✅ SELECT_PLANT handler completed\n");
}

/**
 * Load and send varieties (subtypes)
 */
async function loadVarieties(mobileNumber, state) {
  console.log("\n🍃 [LOAD] Loading varieties for plant:", state.order.plant);
  try {
    const plant = await PlantCms.findById(state.order.plant).select("subtypes name");
    console.log(`   📊 Plant found: ${plant?.name || "Not found"}`);
    
    if (!plant || !plant.subtypes || plant.subtypes.length === 0) {
      console.log("   ⚠️  No varieties found");
      await sendWhatsAppMessage(mobileNumber, "❌ No varieties available for this plant.");
      state.step = "SELECT_PLANT";
      saveConversationState(mobileNumber, state);
      await loadPlants(mobileNumber, state);
      return;
    }

    console.log(`   📊 Found ${plant.subtypes.length} varieties`);
    let message = "🍃 Banana varieties:\n\n";
    state.lists.varieties = [];
    plant.subtypes.forEach((subtype, idx) => {
      // Get the first rate from rates array, or default to 0
      const rate = subtype.rates && subtype.rates.length > 0 ? subtype.rates[0] : 0;
      message += `${idx + 1}️⃣ ${subtype.name} – ₹${rate}\n`;
      state.lists.varieties[idx] = {
        id: subtype._id.toString(),
        name: subtype.name,
        rate: rate,
      };
      console.log(`   ${idx + 1}. ${subtype.name} - ₹${rate} (ID: ${subtype._id})`);
    });
    message += "\nSelect variety";

    console.log("   ✅ Varieties loaded, sending to user");
    await sendWhatsAppMessage(mobileNumber, message);
    console.log("   ✅ Varieties message sent\n");
  } catch (error) {
    console.error("   ❌ Error loading varieties:", error);
    console.error("   Stack:", error.stack);
    await sendWhatsAppMessage(mobileNumber, "❌ Error loading varieties. Please try again.");
    state.step = "SELECT_PLANT";
    saveConversationState(mobileNumber, state);
    await loadPlants(mobileNumber, state);
  }
}

/**
 * STEP 3: Select Variety
 */
async function handleVarietySelection(mobileNumber, message, state) {
  console.log("\n🍃 [STEP] SELECT_VARIETY Handler");
  console.log(`   📝 User input: "${message}"`);
  
  if (!state.lists.varieties || state.lists.varieties.length === 0) {
    console.log("   ⚠️  Varieties list empty, reloading...");
    await loadVarieties(mobileNumber, state);
    return;
  }

  const selectedIdx = parseInt(message) - 1;
  console.log(`   🔢 Parsed index: ${selectedIdx} (from input "${message}")`);
  console.log(`   📊 Available varieties: ${state.lists.varieties.length}`);
  
  if (selectedIdx >= 0 && selectedIdx < state.lists.varieties.length) {
    const selectedVariety = state.lists.varieties[selectedIdx];
    console.log(`   ✅ Valid selection: ${selectedVariety.name} (ID: ${selectedVariety.id}, Rate: ₹${selectedVariety.rate})`);
    
    state.order.variety = selectedVariety.id;
    state.order.varietyName = selectedVariety.name;
    state.order.rate = selectedVariety.rate;
    console.log(`   💾 Updated order.variety: ${state.order.variety}`);
    console.log(`   💾 Updated order.varietyName: ${state.order.varietyName}`);
    console.log(`   💾 Updated order.rate: ₹${state.order.rate}`);
    
    await sendWhatsAppMessage(
      mobileNumber,
      `✅ Variety: ${selectedVariety.name}\nRate: ₹${selectedVariety.rate}\n\n📦 Select tray cavity:\n\n1️⃣ 50\n2️⃣ 100\n3️⃣ 200`
    );
    state.step = "SELECT_CAVITY";
    saveConversationState(mobileNumber, state);
  } else {
    console.log(`   ❌ Invalid selection (index ${selectedIdx} out of range)`);
    await sendWhatsAppMessage(mobileNumber, "❌ Invalid selection. Please try again:");
    await loadVarieties(mobileNumber, state);
  }
  saveConversationState(mobileNumber, state);
  console.log("   ✅ SELECT_VARIETY handler completed\n");
}

/**
 * STEP 4: Select Cavity
 */
async function handleCavitySelection(mobileNumber, message, state) {
  console.log("\n📦 [STEP] SELECT_CAVITY Handler");
  console.log(`   📝 User input: "${message}"`);
  
  const cavities = ["50", "100", "200"];
  const selectedIdx = parseInt(message) - 1;
  console.log(`   🔢 Parsed index: ${selectedIdx} (from input "${message}")`);
  console.log(`   📊 Available cavities: ${cavities.join(", ")}`);

  if (selectedIdx >= 0 && selectedIdx < cavities.length) {
    const selectedCavity = cavities[selectedIdx];
    console.log(`   ✅ Valid selection: ${selectedCavity}`);
    
    state.order.cavity = selectedCavity;
    console.log(`   💾 Updated order.cavity: ${state.order.cavity}`);
    
    await sendWhatsAppMessage(
      mobileNumber,
      `✅ Cavity: ${selectedCavity}\n\n🔢 Enter quantity (number only)\n\nExample: 500`
    );
    state.step = "ENTER_QUANTITY";
    saveConversationState(mobileNumber, state);
  } else {
    console.log(`   ❌ Invalid selection (index ${selectedIdx} out of range)`);
    await sendWhatsAppMessage(mobileNumber, "❌ Invalid selection. Please select 1, 2, or 3:");
  }
  saveConversationState(mobileNumber, state);
  console.log("   ✅ SELECT_CAVITY handler completed\n");
}

/**
 * STEP 5: Enter Quantity
 */
async function handleQuantity(mobileNumber, message, state) {
  console.log("\n🔢 [STEP] ENTER_QUANTITY Handler");
  console.log(`   📝 User input: "${message}"`);
  
  const quantity = parseInt(message);
  console.log(`   🔢 Parsed quantity: ${quantity}`);
  console.log(`   💰 Current rate: ₹${state.order.rate}`);
  
  if (isNaN(quantity) || quantity <= 0 || quantity > 10000) {
    console.log(`   ❌ Invalid quantity: ${quantity} (must be 1-10000)`);
    await sendWhatsAppMessage(
      mobileNumber,
      "❌ Invalid quantity. Please enter a number between 1 and 10000:"
    );
    return;
  }

  state.order.quantity = quantity;
  state.order.total = quantity * parseFloat(state.order.rate);
  console.log(`   ✅ Valid quantity: ${quantity}`);
  console.log(`   💾 Updated order.quantity: ${state.order.quantity}`);
  console.log(`   💾 Updated order.total: ₹${state.order.total}`);
  console.log(`   💵 Calculation: ${quantity} × ₹${state.order.rate} = ₹${state.order.total}`);
  
  await sendWhatsAppMessage(
    mobileNumber,
    `✅ Quantity: ${quantity}\n\nLoading available delivery dates...`
  );
  
  state.step = "SELECT_DATE";
  saveConversationState(mobileNumber, state);
  await loadDeliveryDates(mobileNumber, state);
  console.log("   ✅ ENTER_QUANTITY handler completed\n");
}

/**
 * Load and send available delivery dates
 */
async function loadDeliveryDates(mobileNumber, state) {
  console.log("\n📅 [LOAD] Loading delivery slots...");
  console.log(`   🌱 Plant ID: ${state.order.plant}`);
  console.log(`   🍃 Variety ID: ${state.order.variety}`);
  
  try {
    const slots = await PlantSlot.find({
      plantId: state.order.plant,
      subtypeId: state.order.variety,
      availableQuantity: { $gt: 0 },
    })
      .sort({ startDay: 1 })
      .limit(5)
      .select("startDay endDay availableQuantity _id");

    console.log(`   📊 Found ${slots.length} available slots`);

    if (slots.length === 0) {
      console.log("   ⚠️  No slots found");
      await sendWhatsAppMessage(
        mobileNumber,
        "❌ No delivery slots available. Please try a different plant/variety."
      );
      state.step = "SELECT_PLANT";
      saveConversationState(mobileNumber, state);
      await loadPlants(mobileNumber, state);
      return;
    }

    let message = "📅 Select delivery week:\n\n";
    state.lists.slots = [];
    slots.forEach((slot, idx) => {
      message += `${idx + 1}️⃣ ${slot.startDay}–${slot.endDay} (Available: ${slot.availableQuantity})\n`;
      state.lists.slots[idx] = {
        id: slot._id.toString(),
        startDay: slot.startDay,
        endDay: slot.endDay,
      };
      console.log(`   ${idx + 1}. ${slot.startDay}–${slot.endDay} (Available: ${slot.availableQuantity}, ID: ${slot._id})`);
    });

    console.log("   ✅ Slots loaded, sending to user");
    await sendWhatsAppMessage(mobileNumber, message);
    console.log("   ✅ Slots message sent\n");
  } catch (error) {
    console.error("   ❌ Error loading slots:", error);
    console.error("   Stack:", error.stack);
    await sendWhatsAppMessage(mobileNumber, "❌ Error loading delivery dates. Please try again.");
    state.step = "SELECT_PLANT";
    saveConversationState(mobileNumber, state);
    await loadPlants(mobileNumber, state);
  }
}

/**
 * STEP 6: Select Delivery Date
 */
async function handleDateSelection(mobileNumber, message, state) {
  console.log("\n📅 [STEP] SELECT_DATE Handler");
  console.log(`   📝 User input: "${message}"`);
  
  if (!state.lists.slots || state.lists.slots.length === 0) {
    console.log("   ⚠️  Slots list empty, reloading...");
    await loadDeliveryDates(mobileNumber, state);
    return;
  }

  const selectedIdx = parseInt(message) - 1;
  console.log(`   🔢 Parsed index: ${selectedIdx} (from input "${message}")`);
  console.log(`   📊 Available slots: ${state.lists.slots.length}`);
  
  if (selectedIdx >= 0 && selectedIdx < state.lists.slots.length) {
    const slot = state.lists.slots[selectedIdx];
    console.log(`   ✅ Valid selection: ${slot.startDay}–${slot.endDay} (ID: ${slot.id})`);
    
    state.order.deliveryDate = `${slot.startDay} to ${slot.endDay}`;
    state.order.slotId = slot.id;
    console.log(`   💾 Updated order.deliveryDate: ${state.order.deliveryDate}`);
    console.log(`   💾 Updated order.slotId: ${state.order.slotId}`);

    // Show order summary
    const summary = `📋 *Order Summary*

🌱 Plant: ${state.order.plantName}
🍃 Variety: ${state.order.varietyName}
📦 Cavity: ${state.order.cavity}
🔢 Quantity: ${state.order.quantity}
💰 Rate: ₹${state.order.rate}
💵 Total: ₹${state.order.total}
📅 Delivery: ${state.order.deliveryDate}

Reply:
1️⃣ Confirm Order
2️⃣ Cancel`;

    console.log("   📋 Showing order summary to user");
    await sendWhatsAppMessage(mobileNumber, summary);
    state.step = "CONFIRM_ORDER";
    saveConversationState(mobileNumber, state);
  } else {
    console.log(`   ❌ Invalid selection (index ${selectedIdx} out of range)`);
    await sendWhatsAppMessage(mobileNumber, "❌ Invalid selection. Please try again:");
    await loadDeliveryDates(mobileNumber, state);
  }
  saveConversationState(mobileNumber, state);
  console.log("   ✅ SELECT_DATE handler completed\n");
}

/**
 * STEP 7: Confirmation - Create Order
 */
async function handleConfirmation(mobileNumber, message, state) {
  console.log("\n✅ [STEP] CONFIRM_ORDER Handler");
  console.log(`   📝 User input: "${message}"`);
  
  if (message === "1" || message === "confirm" || message === "yes") {
    console.log("   ✅ User confirmed order");
    await sendWhatsAppMessage(
      mobileNumber,
      "⏳ Processing your order... Please wait."
    );

    try {
      console.log("\n   👤 [FARMER] Looking up farmer...");
      // Find or create farmer
      let farmer = await Farmer.findOne({ mobileNumber: parseInt(mobileNumber) });
      let farmerName = "Unknown";

      if (!farmer) {
        console.log("   🆕 Farmer not found, creating new farmer record...");
        // Create minimal farmer record
        farmer = await new Farmer({
          name: "WhatsApp Customer",
          mobileNumber: parseInt(mobileNumber),
          village: "To be updated",
          taluka: "To be updated",
          district: "To be updated",
          state: "Maharashtra",
          stateName: "Maharashtra",
          talukaName: "To be updated",
          districtName: "To be updated",
        }).save();
        farmerName = "WhatsApp Customer";
        console.log(`   ✅ New farmer created: ${farmerName} (ID: ${farmer._id})`);
      } else {
        farmerName = farmer.name || "Unknown";
        console.log(`   ✅ Existing farmer found: ${farmerName} (ID: ${farmer._id})`);
      }

      // Prepare order payload
      console.log("\n   📦 [ORDER] Preparing order payload...");
      const orderPayload = {
        name: farmerName,
        mobileNumber: mobileNumber,
        village: farmer.village || "To be updated",
        taluka: farmer.taluka || farmer.talukaName || "To be updated",
        district: farmer.district || farmer.districtName || "To be updated",
        state: farmer.state || farmer.stateName || "Maharashtra",
        stateName: farmer.stateName || farmer.state || "Maharashtra",
        districtName: farmer.districtName || farmer.district || "To be updated",
        talukaName: farmer.talukaName || farmer.taluka || "To be updated",
        typeOfPlants: "",
        numberOfPlants: state.order.quantity,
        rate: parseFloat(state.order.rate),
        paymentStatus: "not paid",
        orderStatus: "PENDING",
        plantName: state.order.plant,
        plantSubtype: state.order.variety,
        bookingSlot: state.order.slotId,
        deliveryDate: new Date().toISOString(),
        orderPaymentStatus: "PENDING",
        cavity: parseInt(state.order.cavity),
        orderBookingDate: new Date().toISOString(),
      };
      console.log("   📋 Order payload:", JSON.stringify(orderPayload, null, 2));

      // Create order using internal API call
      const API_BASE_URL = process.env.API_BASE_URL || "http://localhost:8000";
      const orderUrl = `${API_BASE_URL}/api/v1/farmer/createFarmer`;
      console.log(`\n   🌐 [API] Calling order creation endpoint: ${orderUrl}`);
      
      const orderResponse = await fetch(orderUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(orderPayload),
      });

      console.log(`   📡 [API] Response status: ${orderResponse.status}`);
      const orderResult = await orderResponse.json();
      console.log("   📡 [API] Response data:", JSON.stringify(orderResult, null, 2));

      if (orderResult.success || orderResult.data) {
        const orderId = orderResult.data?.orderId || orderResult.orderId || "Processing...";
        console.log(`   ✅ Order created successfully! Order ID: ${orderId}`);
        
        await sendWhatsAppMessage(
          mobileNumber,
          `✅ *Order Placed Successfully!*\n\n🧾 Order ID: ${orderId}\n📅 Delivery: ${state.order.deliveryDate}\n\nThank you 🙏\n\nType HI to place another order`
        );

        // Send admin notification
        console.log("\n   📤 [NOTIFICATION] Sending admin notification...");
        await sendAdminNotification({
          customerName: farmerName,
          mobileNumber: mobileNumber,
          plantName: state.order.plantName,
          varietyName: state.order.varietyName,
          cavity: state.order.cavity,
          quantity: state.order.quantity,
          total: state.order.total,
          deliveryDate: state.order.deliveryDate,
          orderId: orderId,
        });
        console.log("   ✅ Admin notification sent");

        clearConversationState(mobileNumber);
        console.log("   ✅ CONFIRM_ORDER handler completed successfully\n");
      } else {
        console.error("   ❌ Order creation failed - API returned error");
        throw new Error("Order creation failed");
      }
    } catch (error) {
      console.error("\n   ❌ [ERROR] Error creating order:", error);
      console.error("   Stack:", error.stack);
      await sendWhatsAppMessage(
        mobileNumber,
        "❌ Sorry, there was an error processing your order. Please try again or contact support."
      );
      clearConversationState(mobileNumber);
    }
  } else {
    console.log("   ❌ User cancelled order");
    await sendWhatsAppMessage(mobileNumber, "❌ Order cancelled.\n\nType HI to start again.");
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
  state.step = "MAIN_MENU";
  saveConversationState(mobileNumber, state);

  await handleMainMenu(mobileNumber, state);

  return res.status(200).json(
    generateResponse("success", "Order flow started", { mobileNumber })
  );
});

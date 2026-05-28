/**
 * WATI farm-ready template button flow:
 * - "शेत तयार आहे" → record confirmation on order
 * - "दुसरी तारीख निवडा" → offer next 5 delivery dates → confirm → update order.deliveryDate
 */

import Order from "../models/order.model.js";
import WhatsappFarmReadySession from "../models/whatsappFarmReadySession.model.js";
import { lookupFarmerByMobile } from "./whatsappOrderFarmer.service.js";
import { sendSessionTextMessage } from "./watiService.js";
import {
  extractInboundMessage,
  extractInboundMessageId,
  normalizeWhatsAppNumberForWati,
} from "../utility/watiInboundPayload.js";

export const FARM_READY_BTN_CONFIRM = "शेत तयार आहे";
export const FARM_READY_BTN_RESCHEDULE = "दुसरी तारीख निवडा";

const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const RESCHEDULABLE_STATUSES = ["FARM_READY", "ACCEPTED", "READY_FOR_DISPATCH"];

const MONTHS_MR = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/** @param {Date} d */
export function formatDeliveryDateLabel(d) {
  const date = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(date.getTime())) return "—";
  const day = date.getDate();
  const month = MONTHS_MR[date.getMonth()] || "";
  const year = date.getFullYear();
  return `${String(day).padStart(2, "0")} ${month} ${year}`;
}

/** @param {Date} d */
export function formatDeliveryDateShortIn(d) {
  const date = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}

/**
 * Next `count` calendar days after base delivery date (or today if unset).
 * @param {Date|null|undefined} baseDeliveryDate
 * @param {number} [count=5]
 * @returns {Date[]}
 */
export function buildNextDeliveryDateOptions(baseDeliveryDate, count = 5) {
  const base = baseDeliveryDate ? startOfDay(new Date(baseDeliveryDate)) : startOfDay(new Date());
  const out = [];
  for (let i = 1; i <= count; i++) {
    const d = new Date(base);
    d.setDate(d.getDate() + i);
    out.push(startOfDay(d));
  }
  return out;
}

function startOfDay(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function sameCalendarDay(a, b) {
  if (!a || !b) return false;
  return startOfDay(a).getTime() === startOfDay(b).getTime();
}

function normalizeInboundText(text) {
  return String(text ?? "")
    .trim()
    .replace(/\s+/g, " ");
}

/**
 * Confirm step: `1` = yes, `2` = cancel. Farmer may also reply with the date label again.
 * @param {string} text
 * @param {Date|null} [selectedDate]
 * @returns {"confirm"|"cancel"|null}
 */
export function parseConfirmChoiceFromReply(text, selectedDate = null) {
  const t = normalizeInboundText(text);
  const digitsOnly = t.replace(/[^\d]/g, "");
  if (digitsOnly === "1" || t === "1️⃣") return "confirm";
  if (digitsOnly === "2" || t === "2️⃣") return "cancel";

  if (selectedDate) {
    const label = formatDeliveryDateLabel(selectedDate);
    const short = formatDeliveryDateShortIn(selectedDate);
    if (t === label || t.includes(label) || t.includes(short)) {
      return "confirm";
    }
  }

  return null;
}

/**
 * @param {string} text
 * @param {Date[]} offeredDates
 * @returns {Date|null}
 */
export function parseDateChoiceFromReply(text, offeredDates) {
  const t = normalizeInboundText(text);
  const num = parseInt(t.replace(/[^\d]/g, ""), 10);
  if (Number.isFinite(num) && num >= 1 && num <= offeredDates.length) {
    return offeredDates[num - 1];
  }
  for (const d of offeredDates) {
    const label = formatDeliveryDateLabel(d);
    if (t.includes(label) || t.includes(formatDeliveryDateShortIn(d))) {
      return d;
    }
  }
  return null;
}

export function isFarmReadyButtonMessage(text) {
  const t = normalizeInboundText(text);
  return t === FARM_READY_BTN_CONFIRM || t === FARM_READY_BTN_RESCHEDULE;
}

/**
 * @param {import("mongoose").Types.ObjectId|string} farmerId
 */
export async function findActiveFarmReadyOrderForFarmer(farmerId) {
  return Order.findOne({
    farmer: farmerId,
    orderStatus: { $in: RESCHEDULABLE_STATUSES },
  })
    .sort({ deliveryDate: 1, updatedAt: -1 })
    .populate("farmer", "name mobileNumber village")
    .populate("plantName", "name");
}

async function sendWatiReply(waId, messageText) {
  const digits = normalizeWhatsAppNumberForWati(waId);
  if (!digits) {
    throw new Error("Invalid waId for WATI reply");
  }
  return sendSessionTextMessage({ whatsappNumber: digits, messageText });
}

/**
 * @param {object} order
 * @param {string} waId
 * @param {string} [messageId]
 */
export async function confirmFarmReadyViaWhatsapp(order, waId, messageId = "") {
  const now = new Date();
  order.farmReadyWhatsappConfirmedAt = now;
  if (messageId) {
    order.farmerWhatsappDeliveryReschedule = order.farmerWhatsappDeliveryReschedule || {};
    order.farmerWhatsappDeliveryReschedule.whatsappMessageId = messageId;
  }
  order.orderEditHistory = order.orderEditHistory || [];
  order.orderEditHistory.push({
    field: "farmReadyWhatsappConfirmedAt",
    previousValue: null,
    newValue: now,
    changedBy: null,
    notes: "Farmer confirmed farm is ready via WATI button (शेत तयार आहे)",
  });
  await order.save();

  const deliveryLabel = order.deliveryDate
    ? formatDeliveryDateShortIn(order.deliveryDate)
    : "लवकरच";
  const orderCode = order.publicOrderCode || order.orderId || order._id;

  await sendWatiReply(
    waId,
    [
      "✅ धन्यवाद!",
      "",
      "आपले शेत तयार असल्याची नोंद झाली.",
      `📦 ऑर्डर: ${orderCode}`,
      `🌱 ${order.plantName?.name || "रोप"} — ${order.numberOfPlants || 0} रोपे`,
      `📅 वितरण तारीख: ${deliveryLabel}`,
      "",
      "कोणतीही समस्या असल्यास आमच्याशी संपर्क साधा.",
    ].join("\n")
  );

  return { handled: true, action: "farm_ready_confirmed", orderId: String(order._id) };
}

/**
 * @param {object} order
 * @param {string} mobile10
 * @param {string} waId
 * @param {string} [messageId]
 */
export async function startRescheduleDateOffer(order, mobile10, waId, messageId = "") {
  const oldDeliveryDate = order.deliveryDate ? new Date(order.deliveryDate) : null;
  const offeredDates = buildNextDeliveryDateOptions(oldDeliveryDate, 5);
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);

  await WhatsappFarmReadySession.findOneAndUpdate(
    { mobile10 },
    {
      mobile10,
      orderId: order._id,
      step: "offered_dates",
      offeredDates,
      selectedDate: null,
      oldDeliveryDate,
      lastInboundMessageId: messageId || null,
      expiresAt,
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  const lines = [
    "🗓️ कृपया नवीन वितरण तारीख निवडा:",
    "",
  ];
  offeredDates.forEach((d, i) => {
    lines.push(`${i + 1}. ${formatDeliveryDateLabel(d)}`);
  });
  lines.push("", "📌 वरील क्रमांक (1–5) पाठवा.");

  if (oldDeliveryDate) {
    lines.push("", `📅 सध्याची तारीख: ${formatDeliveryDateShortIn(oldDeliveryDate)}`);
  }

  await sendWatiReply(waId, lines.join("\n"));

  return { handled: true, action: "reschedule_dates_offered", orderId: String(order._id) };
}

/**
 * @param {object} session
 * @param {object} order
 * @param {string} waId
 * @param {Date} selectedDate
 * @param {string} [messageId]
 */
export async function promptRescheduleConfirmation(session, order, waId, selectedDate, messageId = "") {
  session.step = "await_confirm";
  session.selectedDate = selectedDate;
  session.lastInboundMessageId = messageId || session.lastInboundMessageId;
  session.expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await session.save();

  const orderCode = order.publicOrderCode || order.orderId || order._id;
  const dateLabel = formatDeliveryDateLabel(selectedDate);
  await sendWatiReply(
    waId,
    [
      "✅ नवीन वितरण तारीख:",
      `📅 ${dateLabel}`,
      "",
      `📦 ऑर्डर: ${orderCode}`,
      "",
      "कृपया निवडा:",
      `1. ${dateLabel} — निश्चित करा`,
      "2. रद्द करा",
      "",
      "📌 `1` पाठवा — पुष्टी | `2` — रद्द",
    ].join("\n")
  );

  return { handled: true, action: "await_confirm", orderId: String(order._id) };
}

/**
 * @param {object} order
 * @param {object} session
 * @param {string} waId
 * @param {string} [messageId]
 */
export async function applyFarmerDeliveryReschedule(order, session, waId, messageId = "") {
  const newDate = session.selectedDate;
  const oldDate = session.oldDeliveryDate || order.deliveryDate || null;

  if (!newDate) {
    await sendWatiReply(waId, "⚠️ तारीख निवडली नाही. कृपया पुन्हा प्रयत्न करा.");
    await WhatsappFarmReadySession.deleteOne({ _id: session._id });
    return { handled: true, action: "error_no_date" };
  }

  const previousDelivery = order.deliveryDate ? new Date(order.deliveryDate) : null;
  order.deliveryDate = startOfDay(new Date(newDate));
  order.farmerWhatsappDeliveryReschedule = {
    rescheduledBy: "FARMER",
    rescheduledAt: new Date(),
    oldDeliveryDate: oldDate ? startOfDay(new Date(oldDate)) : previousDelivery,
    whatsappMessageId: messageId || session.lastInboundMessageId || null,
  };

  order.orderEditHistory = order.orderEditHistory || [];
  order.orderEditHistory.push({
    field: "deliveryDate",
    previousValue: previousDelivery,
    newValue: order.deliveryDate,
    changedBy: null,
    notes: `Farmer rescheduled delivery via WATI WhatsApp (confirmed). Old: ${
      previousDelivery ? formatDeliveryDateShortIn(previousDelivery) : "Not set"
    }`,
  });

  await order.save();
  await WhatsappFarmReadySession.deleteOne({ _id: session._id });

  const orderCode = order.publicOrderCode || order.orderId || order._id;
  await sendWatiReply(
    waId,
    [
      "✅ धन्यवाद!",
      "",
      "आपली वितरण तारीख निश्चित झाली.",
      `📅 ${formatDeliveryDateLabel(order.deliveryDate)}`,
      `📦 ऑर्डर: ${orderCode}`,
      "",
      "आमचा प्रतिनिधी लवकरच संपर्क साधेल.",
    ].join("\n")
  );

  return {
    handled: true,
    action: "delivery_rescheduled",
    orderId: String(order._id),
    newDeliveryDate: order.deliveryDate,
  };
}

/**
 * Continue multi-step reschedule session.
 * @returns {Promise<{ handled: boolean, action?: string }>}
 */
export async function continueRescheduleSession(mobile10, waId, text, messageId = "") {
  const session = await WhatsappFarmReadySession.findOne({ mobile10 }).populate({
    path: "orderId",
    populate: [{ path: "farmer", select: "name mobileNumber" }, { path: "plantName", select: "name" }],
  });

  if (!session?.orderId) {
    return { handled: false };
  }

  const order = session.orderId;
  const t = normalizeInboundText(text);

  if (session.step === "offered_dates") {
    const picked = parseDateChoiceFromReply(t, session.offeredDates || []);
    if (!picked) {
      await sendWatiReply(
        waId,
        "⚠️ कृपया 1 ते 5 मधील क्रमांक पाठवा.\n\nउदा. `2` — दुसऱ्या तारखेसाठी."
      );
      return { handled: true, action: "invalid_date_choice" };
    }
    return promptRescheduleConfirmation(session, order, waId, picked, messageId);
  }

  if (session.step === "await_confirm") {
    const choice = parseConfirmChoiceFromReply(t, session.selectedDate);
    if (choice === "cancel") {
      await WhatsappFarmReadySession.deleteOne({ _id: session._id });
      await sendWatiReply(waId, "❌ तारीख बदल रद्द केला. सध्याची तारीख कायम राहील.");
      return { handled: true, action: "reschedule_cancelled" };
    }
    if (choice !== "confirm") {
      await sendWatiReply(
        waId,
        "⚠️ कृपया `1` (पुष्टी) किंवा `2` (रद्द) पाठवा.\n\nतारीख पुन्हा पाठवल्यासही पुष्टी होते."
      );
      return { handled: true, action: "await_confirm_retry" };
    }
    return applyFarmerDeliveryReschedule(order, session, waId, messageId);
  }

  return { handled: false };
}

/**
 * Main entry from WATI webhook body.
 * @returns {Promise<{ handled: boolean, action?: string }>}
 */
export async function runFarmReadyWebhookFromBody(body) {
  const { text, waId } = extractInboundMessage(body);
  const messageId = extractInboundMessageId(body);
  const inbound = normalizeInboundText(text);

  if (!waId || !inbound) {
    return { handled: false };
  }

  const mobile10 =
    String(waId).replace(/\D/g, "").length === 12
      ? String(waId).replace(/\D/g, "").slice(2)
      : String(waId).replace(/\D/g, "").slice(-10);

  if (!mobile10 || mobile10.length !== 10) {
    return { handled: false };
  }

  // Active reschedule session takes priority over new button clicks
  const activeSession = await WhatsappFarmReadySession.findOne({ mobile10 }).lean();
  if (activeSession) {
    return continueRescheduleSession(mobile10, waId, inbound, messageId);
  }

  if (!isFarmReadyButtonMessage(inbound)) {
    return { handled: false };
  }

  const farmer = await lookupFarmerByMobile(mobile10);
  if (!farmer?.id) {
    await sendWatiReply(
      waId,
      "⚠️ आपला मोबाईल नंबर आमच्या नोंदींमध्ये सापडला नाही. कृपया नर्सरीशी संपर्क साधा."
    );
    return { handled: true, action: "farmer_not_found" };
  }

  const order = await findActiveFarmReadyOrderForFarmer(farmer.id);
  if (!order) {
    await sendWatiReply(
      waId,
      "⚠️ सध्या कोणतीही सक्रिय ऑर्डर सापडली नाही. कृपया नर्सरीशी संपर्क साधा."
    );
    return { handled: true, action: "order_not_found" };
  }

  if (inbound === FARM_READY_BTN_CONFIRM) {
    return confirmFarmReadyViaWhatsapp(order, waId, messageId);
  }

  if (inbound === FARM_READY_BTN_RESCHEDULE) {
    return startRescheduleDateOffer(order, mobile10, waId, messageId);
  }

  return { handled: false };
}

export async function storeFarmReadyTemplateSendMeta(orderId, localMessageId) {
  if (!orderId) return;
  const set = { whatsappFarmReadySentAt: new Date() };
  if (localMessageId) {
    set.whatsappFarmReadyMessageKey = String(localMessageId);
  }
  await Order.updateOne({ _id: orderId }, { $set: set }).catch(() => {});
}

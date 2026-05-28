/**
 * WATI farm-ready template button flow:
 * - "शेत तयार आहे" → record confirmation on order
 * - "दुसरी तारीख निवडा" → offer next 5 booking slots → confirm → update bookingSlot + deliveryDate
 */

import Order from "../models/order.model.js";
import WhatsappFarmReadySession from "../models/whatsappFarmReadySession.model.js";
import { lookupFarmerByMobile } from "./whatsappOrderFarmer.service.js";
import { sendSessionTextMessage } from "./watiService.js";
import {
  findNextSlotOptionsForOrder,
  parseSlotChoiceFromReply,
  applyFarmerSlotReschedule,
} from "./whatsappFarmReadySlot.service.js";
import {
  extractInboundMessage,
  extractInboundMessageId,
  normalizeWhatsAppNumberForWati,
} from "../utility/watiInboundPayload.js";
import {
  findOrderForFarmReadyReply,
  extractReplyContextId,
} from "../utility/whatsappFarmReadyOrderResolve.js";

export const FARM_READY_BTN_CONFIRM = "शेत तयार आहे";
export const FARM_READY_BTN_CONFIRM_DOTTED = "शेत तयार आहे.";
export const FARM_READY_BTN_RESCHEDULE = "दुसरी तारीख निवडा";

const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

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
export function parseConfirmChoiceFromReply(text, selectedLabel = null) {
  const t = normalizeInboundText(text);
  const digitsOnly = t.replace(/[^\d]/g, "");
  if (digitsOnly === "1" || t === "1️⃣") return "confirm";
  if (digitsOnly === "2" || t === "2️⃣") return "cancel";

  if (selectedLabel && (t === selectedLabel || t.includes(selectedLabel))) {
    return "confirm";
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
  return (
    t === FARM_READY_BTN_CONFIRM ||
    t === FARM_READY_BTN_CONFIRM_DOTTED ||
    t === FARM_READY_BTN_RESCHEDULE
  );
}

/**
 * @deprecated Prefer findOrderForFarmReadyReply — kept for tests / fallback export.
 * @param {import("mongoose").Types.ObjectId|string} farmerId
 */
export async function findActiveFarmReadyOrderForFarmer(farmerId) {
  return findOrderForFarmReadyReply({ body: {}, farmerId, inboundText: "" });
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
  const prevStatus = String(order.orderStatus || "");
  const confirmNote = messageId
    ? `Farmer confirmed farm is ready via WATI button (शेत तयार आहे) [${messageId}]`
    : "Farmer confirmed farm is ready via WATI button (शेत तयार आहे)";

  const $set = { farmReadyWhatsappConfirmedAt: now };
  const $push = {};
  const historyEntries = [
    {
      field: "farmReadyWhatsappConfirmedAt",
      previousValue: order.farmReadyWhatsappConfirmedAt || null,
      newValue: now,
      changedBy: null,
      notes: confirmNote,
    },
  ];

  let statusUpdated = false;
  if (prevStatus === "ACCEPTED") {
    $set.orderStatus = "FARM_READY";
    if (!order.farmReadyDate) {
      $set.farmReadyDate = now;
      $push.farmReadyDateChanges = {
        previousDate: null,
        newDate: now,
        reason: "Farmer confirmed farm ready via WATI WhatsApp",
        notes: confirmNote,
      };
    }
    $push.statusChanges = {
      previousStatus: prevStatus,
      newStatus: "FARM_READY",
      reason: "Farmer tapped शेत तयार आहे on WATI",
      notes: messageId || "",
    };
    historyEntries.push({
      field: "orderStatus",
      previousValue: prevStatus,
      newValue: "FARM_READY",
      changedBy: null,
      notes: "Auto-updated when farmer confirmed farm ready via WATI WhatsApp",
    });
    statusUpdated = true;
  }

  $push.orderEditHistory =
    historyEntries.length === 1 ? historyEntries[0] : { $each: historyEntries };

  await Order.updateOne({ _id: order._id }, { $set, $push });

  if (statusUpdated) {
    order.orderStatus = "FARM_READY";
    if (!order.farmReadyDate) order.farmReadyDate = now;
    console.log(
      `[farm-ready] Order ${order.publicOrderCode || order.orderId || order._id}: ACCEPTED → FARM_READY (farmer WhatsApp confirm)`
    );
  }

  order.farmReadyWhatsappConfirmedAt = now;

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
      statusUpdated ? "📋 ऑर्डर स्थिती: शेत तयार (Farm Ready)" : "",
      `📦 ऑर्डर: ${orderCode}`,
      `🌱 ${order.plantName?.name || "रोप"} — ${order.numberOfPlants || 0} रोपे`,
      `📅 वितरण तारीख: ${deliveryLabel}`,
      "",
      "कोणतीही समस्या असल्यास आमच्याशी संपर्क साधा.",
    ]
      .filter(Boolean)
      .join("\n")
  );

  return {
    handled: true,
    action: statusUpdated ? "farm_ready_confirmed_status_updated" : "farm_ready_confirmed",
    orderId: String(order._id),
    previousStatus: prevStatus,
    newStatus: statusUpdated ? "FARM_READY" : prevStatus,
  };
}

/**
 * @param {object} order
 * @param {string} mobile10
 * @param {string} waId
 * @param {string} [messageId]
 */
export async function startRescheduleDateOffer(order, mobile10, waId, messageId = "") {
  const oldDeliveryDate = order.deliveryDate ? new Date(order.deliveryDate) : null;
  const offeredSlots = await findNextSlotOptionsForOrder(order, 5);
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);

  if (!offeredSlots.length) {
    await sendWatiReply(
      waId,
      "⚠️ सध्या पुढील स्लॉट उपलब्ध नाहीत. कृपया 📞 7218186452 वर संपर्क करा."
    );
    return { handled: true, action: "no_slots_available", orderId: String(order._id) };
  }

  await WhatsappFarmReadySession.findOneAndUpdate(
    { mobile10 },
    {
      mobile10,
      orderId: order._id,
      step: "offered_slots",
      offeredSlots,
      offeredDates: [],
      selectedSlotIndex: null,
      selectedDate: null,
      oldDeliveryDate,
      lastInboundMessageId: messageId || null,
      expiresAt,
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  const orderCode = order.publicOrderCode || order.orderId || order._id;
  const lines = [
    `📦 ऑर्डर आयडी: ${orderCode}`,
    "🗓️ कृपया नवीन डिलिव्हरी स्लॉट निवडा:",
    "",
  ];
  offeredSlots.forEach((s, i) => {
    lines.push(`${i + 1}. ${s.label}`);
  });
  lines.push("", "📌 वरील क्रमांक (1–5) पाठवा.");

  if (oldDeliveryDate) {
    lines.push("", `📅 सध्याची तारीख: ${formatDeliveryDateShortIn(oldDeliveryDate)}`);
  }

  await sendWatiReply(waId, lines.join("\n"));

  return { handled: true, action: "reschedule_slots_offered", orderId: String(order._id) };
}

/**
 * @param {object} session
 * @param {object} order
 * @param {string} waId
 * @param {Date} selectedDate
 * @param {string} [messageId]
 */
export async function promptRescheduleConfirmation(session, order, waId, selectedSlot, messageId = "") {
  session.step = "await_confirm";
  session.selectedSlotIndex = selectedSlot.index;
  session.selectedDate = selectedSlot.deliveryDate || null;
  session.lastInboundMessageId = messageId || session.lastInboundMessageId;
  session.expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await session.save();

  const orderCode = order.publicOrderCode || order.orderId || order._id;
  const slotLabel = selectedSlot.label;
  await sendWatiReply(
    waId,
    [
      "✅ नवीन डिलिव्हरी स्लॉट:",
      `📅 ${slotLabel}`,
      "",
      `📦 ऑर्डर आयडी: ${orderCode}`,
      "",
      "कृपया निवडा:",
      `1. ${slotLabel} — निश्चित करा`,
      "2. रद्द करा",
      "",
      "📌 `1` — पुष्टी | `2` — रद्द",
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
  const offered = session.offeredSlots || [];
  const idx =
    session.selectedSlotIndex != null
      ? session.selectedSlotIndex
      : session.selectedDate
        ? offered.findIndex((s) => s.deliveryDate && sameCalendarDay(s.deliveryDate, session.selectedDate))
        : -1;
  const selectedSlot = idx >= 0 ? offered[idx] : null;

  if (!selectedSlot?.slotId) {
    await sendWatiReply(waId, "⚠️ स्लॉट निवडला नाही. कृपया पुन्हा प्रयत्न करा.");
    await WhatsappFarmReadySession.deleteOne({ _id: session._id });
    return { handled: true, action: "error_no_slot" };
  }

  try {
    const freshOrder = await Order.findById(order._id)
      .populate("plantName", "name")
      .populate("farmer", "name mobileNumber");
    if (!freshOrder) throw new Error("Order not found");

    const { newDeliveryDate, slotLabel } = await applyFarmerSlotReschedule(
      freshOrder,
      selectedSlot,
      messageId || session.lastInboundMessageId || ""
    );

    await WhatsappFarmReadySession.deleteOne({ _id: session._id });

    const orderCode = freshOrder.publicOrderCode || freshOrder.orderId || freshOrder._id;
    await sendWatiReply(
      waId,
      [
        "✅ धन्यवाद!",
        "",
        "आपली डिलिव्हरी स्लॉट निश्चित झाली.",
        `📅 ${slotLabel}`,
        `📦 ऑर्डर आयडी: ${orderCode}`,
        "",
        "स्लॉट ERP मध्ये अपडेट झाला. आमचा प्रतिनिधी लवकरच संपर्क साधेल.",
      ].join("\n")
    );

    return {
      handled: true,
      action: "delivery_rescheduled",
      orderId: String(freshOrder._id),
      newDeliveryDate,
      slotLabel,
    };
  } catch (err) {
    console.error("[farm-ready] slot reschedule failed:", err?.message || err);
    await WhatsappFarmReadySession.deleteOne({ _id: session._id });
    await sendWatiReply(
      waId,
      "⚠️ स्लॉट बदलता आला नाही (कदाचित स्लॉट भरला). 📞 7218186452 वर संपर्क करा."
    );
    return { handled: true, action: "slot_reschedule_failed" };
  }
}

/**
 * Continue multi-step reschedule session.
 * @returns {Promise<{ handled: boolean, action?: string }>}
 */
export async function continueRescheduleSession(mobile10, waId, text, messageId = "") {
  const session = await WhatsappFarmReadySession.findOne({ mobile10 }).populate({
    path: "orderId",
    populate: [
      { path: "farmer", select: "name mobileNumber" },
      { path: "plantName", select: "name" },
      { path: "plantSubtype", select: "name" },
    ],
  });

  if (!session?.orderId) {
    return { handled: false };
  }

  const order = session.orderId;
  const t = normalizeInboundText(text);

  if (session.step === "offered_slots" || session.step === "offered_dates") {
    const offeredSlots = session.offeredSlots?.length
      ? session.offeredSlots
      : (session.offeredDates || []).map((d, i) => ({
          slotId: null,
          label: formatDeliveryDateLabel(d),
          deliveryDate: d,
          index: i,
        }));

    const pickedIdx = parseSlotChoiceFromReply(
      t,
      offeredSlots.map((s) => ({ label: s.label, slotId: String(s.slotId || s.label) }))
    );

    if (pickedIdx == null) {
      await sendWatiReply(
        waId,
        "⚠️ कृपया 1 ते 5 मधील क्रमांक पाठवा.\n\nउदा. `2` — दुसऱ्या स्लॉटसाठी."
      );
      return { handled: true, action: "invalid_slot_choice" };
    }

    const picked = offeredSlots[pickedIdx];
    return promptRescheduleConfirmation(
      session,
      order,
      waId,
      { ...picked, index: pickedIdx },
      messageId
    );
  }

  if (session.step === "await_confirm") {
    const offered = session.offeredSlots || [];
    const selectedLabel =
      session.selectedSlotIndex != null && offered[session.selectedSlotIndex]
        ? offered[session.selectedSlotIndex].label
        : session.selectedDate
          ? formatDeliveryDateLabel(session.selectedDate)
          : null;

    const choice = parseConfirmChoiceFromReply(t, selectedLabel);
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
  try {
    return await runFarmReadyWebhookFromBodyInner(body);
  } catch (err) {
    console.error("[farm-ready] webhook error:", err?.message || err);
    if (err?.stack) console.error(err.stack);
    return { handled: false, error: err?.message || String(err) };
  }
}

async function runFarmReadyWebhookFromBodyInner(body) {
  const { text, waId } = extractInboundMessage(body);
  const messageId = extractInboundMessageId(body);
  const inbound = normalizeInboundText(text);

  console.log("[farm-ready] inbound", {
    waId: waId || "(none)",
    messageId: messageId || "(none)",
    text: inbound ? inbound.slice(0, 80) : "(empty)",
    bodyKeys: Object.keys(body || {}),
  });

  if (!waId || !inbound) {
    console.log("[farm-ready] skip — missing waId or message text/button");
    return { handled: false, reason: "no_waId_or_text" };
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
    console.log("[farm-ready] skip — not a farm-ready button:", inbound.slice(0, 80));
    return { handled: false, reason: "not_farm_ready_button" };
  }

  const farmer = await lookupFarmerByMobile(mobile10);
  if (!farmer?.id) {
    await sendWatiReply(
      waId,
      "⚠️ आपला मोबाईल नंबर आमच्या नोंदींमध्ये सापडला नाही. कृपया नर्सरीशी संपर्क साधा."
    );
    return { handled: true, action: "farmer_not_found" };
  }

  const order = await findOrderForFarmReadyReply({
    body,
    farmerId: farmer.id,
    inboundText: inbound,
  });
  if (!order) {
    await sendWatiReply(
      waId,
      "⚠️ ऑर्डर सापडला नाही. कृपया WhatsApp वर दिसलेला ऑर्डर क्रमांक तपासा किंवा नर्सरीशी संपर्क साधा."
    );
    return { handled: true, action: "order_not_found" };
  }

  const orderCode = order.publicOrderCode || order.orderId || order._id;
  console.log(
    `[farm-ready] Order resolved: ${orderCode} delivery=${order.deliveryDate ? formatDeliveryDateShortIn(order.deliveryDate) : "—"} replyContext=${extractReplyContextId(body) || "—"}`
  );

  if (inbound === FARM_READY_BTN_CONFIRM || inbound === FARM_READY_BTN_CONFIRM_DOTTED) {
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

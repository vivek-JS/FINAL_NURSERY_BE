import moment from "moment";
import {
  fetchBookingReportDataForDateRange,
  formatISTRangeLabel,
  formatPlantSubtypeBlocksForWhatsApp,
} from "./reportService.js";
import {
  generateTodayBookingPdf,
  generateDeliveryQueuePdf,
  generateOrderTransitionInsightsPdf,
  generateSlotsOutlookPdf,
  plantTotalsForBarChart,
} from "./pdfService.js";
import { sendSessionFileMessage, sendSessionTextMessage } from "./watiService.js";
import { uploadToS3 } from "./uploadService.js";
import {
  normalizeWhatsAppNumberForWati,
  extractInboundMessage,
  extractInboundMessageId,
} from "../utility/watiInboundPayload.js";
import { isWatiConfigured } from "../config/wati.config.js";
import {
  buildDeliveryPaymentMatchForWizard,
  fetchDeliveryPipelineForWizard,
  fetchDispatchCompletedForRange,
  fetchFutureSlotHighlights,
  fetchOrderTransitionInsights,
  fetchPaymentStatsForMatch,
  fetchSystemAlertsSnapshot,
  formatDeliveryWhatsApp,
  formatDispatchReportWhatsApp,
  formatOrderTransitionInsightsWhatsApp,
  formatPaymentStatsWhatsApp,
  fetchActiveOrdersPaymentSnapshot,
  matchOrdersInBookingRangeIST,
  splitForWhatsApp,
} from "./whatsappReportData.service.js";
import {
  isReportEntry,
  guessReportTypeFromText,
  parseReportTypeChoice,
  parseDateChoice,
  parseCustomRangeText,
  parseDeliveryWindowChoice,
  parseDeliveryDueFilterChoice,
} from "../utility/whatsappReportWizardParsers.js";
import { isPhoneAllowedForReportWizard } from "../utility/whatsappReportWizardAllowlist.js";

const STATE_TTL_MS = 15 * 60 * 1000;

/** @type {Map<string, object>} */
const reportWizardState = new Map();

const MENU_TEXT = `📋 *Nursery reports*
Reply with a number:
*1* — Booking (PDF + charts, date range)
*2* — Delivery (due window: today / 7 / 14 days / custom + with/without due)
*3* — Slots (PDF + future windows, busiest table)
*4* — Payments (pending, collected, by plant)
*5* — Dispatch / completed (orders touched in date range)

_Type *cancel* anytime._`;

const DELIVERY_WINDOW_PROMPT = `📅 *Delivery — pick planning window (IST)*
*1* — Today
*2* — Next 7 days (today through +6 days)
*3* — Next 14 days (today through +13 days)
*4* — Custom (you’ll type two dates next)

Reply *1–4*, or *cancel*.`;

const DELIVERY_FILTER_PROMPT = `📦 *Which orders include?* (still *ACCEPTED* + *FARM_READY* only)
*1* — *With due* — delivery date falls inside the window you picked
*2* — *Without due* — no delivery date on the order yet
*3* — *Both* — two sections in the report

Reply *1–3*, or *cancel*.`;

const DELIVERY_MODE_CAPTION = {
  due_in_window: "With due date in window",
  no_due: "Without delivery date",
  both: "With due + without due",
};

function datePromptTitle(reportType) {
  const m = {
    booking: "Booking",
    delivery: "Delivery queue",
    slots: "Slots",
    payment: "Payments",
    dispatch: "Dispatch / completed",
  };
  return m[reportType] || "Report";
}

const DATE_PROMPT = (reportType) => `📅 *Pick dates (IST)* — ${datePromptTitle(reportType)}
*1* — Today
*2* — Yesterday
*3* — Last 7 days (rolling)
*4* — Custom (you’ll type two dates next)

_Note: menu *3 Slots* is not filtered by these dates._

Reply *1–4*, or *cancel*.`;

async function sendChunks(whatsappNumber, messageText) {
  const parts = splitForWhatsApp(messageText);
  for (const chunk of parts) {
    await sendSessionTextMessage({ whatsappNumber, messageText: chunk });
  }
}

function formatBookingText(data) {
  const rangeLabel = formatISTRangeLabel(data.range.start, data.range.end);
  const src =
    data.source === "bookings"
      ? "Source: *legacy bookings* collection (createdAt in range)."
      : "Source: *farmer orders* (booking date in range, or createdAt if booking date empty).";

  const lines = [
    "📊 *Booking report*",
    `_${rangeLabel}_`,
    src,
    "",
    `*Totals* — plants: *${data.stats.grandTotal}* | lines: *${data.stats.bookingLines}* | distinct farmers: *${data.stats.uniqueFarmers}*`,
    "",
    "🏆 *Top 3 farmers (by plant qty)*",
  ];

  for (let i = 0; i < (data.topFarmers || []).length; i += 1) {
    const f = data.topFarmers[i];
    lines.push(`  ${i + 1}. ${f.name} — *${f.quantity}* plants`);
  }
  if (!data.topFarmers?.length) {
    lines.push("  — (no named farmers in this range)");
  }

  lines.push("", "🏘️ *Top 3 villages / areas (by plant qty)*");
  for (let i = 0; i < (data.topVillages || []).length; i += 1) {
    const v = data.topVillages[i];
    lines.push(`  ${i + 1}. ${v.name} — *${v.quantity}* plants`);
  }
  if (!data.topVillages?.length) {
    lines.push(
      "  — (villages need farmer location data, or use orders source with populated farmers)"
    );
  }

  lines.push(
    "",
    "🌿 *Plant → subtype (booking qty)*",
    "_Same totals as the PDF summary table._",
    ""
  );
  if ((data.summaryRows || []).length) {
    lines.push(...formatPlantSubtypeBlocksForWhatsApp(data.summaryRows));
  } else {
    lines.push("— No plant/subtype lines in this range.", "");
  }
  lines.push("📎 *PDF attached* — full line-level detail + charts.");
  return lines.join("\n");
}

/** Slots + ops alerts (org-wide payment is menu *4*). */
async function sendCompositeOpsAddOn(phone) {
  const [slots, alerts] = await Promise.all([
    fetchFutureSlotHighlights(),
    fetchSystemAlertsSnapshot(),
  ]);
  await sendChunks(phone, `${slots.text}\n\n${alerts.text}`);
}

async function runSlotsReportWithPdf(phone, range) {
  const slotsData = await fetchFutureSlotHighlights();
  await sendChunks(phone, slotsData.text);
  await sendChunks(
    phone,
    "_Detailed PDF (charts + busiest windows table) is attached below._"
  );

  const rangeLabel = formatISTRangeLabel(range.start, range.end);
  const sessionLabel = `${rangeLabel} · wizard session anchor (slot list is not filtered by these dates)`;

  if (isWatiConfigured()) {
    try {
      const pdfBuffer = await generateSlotsOutlookPdf({
        reportDateLabel: sessionLabel,
        slotRows: slotsData.slotRows || [],
      });
      const filename = `slots-${moment()
        .utcOffset(330)
        .format("YYYYMMDD-HHmmss")}.pdf`;
      await sendSessionFileMessage({
        whatsappNumber: phone,
        fileBuffer: pdfBuffer,
        filename,
        caption: `Slots outlook · ${rangeLabel}`,
      });
      if (process.env.DO_SPACES_KEY) {
        void uploadToS3(pdfBuffer, filename).catch((e) =>
          console.warn("[report wizard] optional Spaces copy failed:", e?.message || e)
        );
      }
    } catch (e) {
      console.error("[report wizard] slots PDF failed:", e?.message || e);
      try {
        await sendSessionTextMessage({
          whatsappNumber: phone,
          messageText: `⚠️ Slots PDF could not be sent: ${(e && e.message) || String(e)}`,
        });
      } catch (_) {
        /* ignore */
      }
    }
  }

  const { text: alertText } = await fetchSystemAlertsSnapshot();
  await sendChunks(phone, alertText);
}

async function runPaymentReport(phone, range) {
  const payRange = await fetchPaymentStatsForMatch(
    matchOrdersInBookingRangeIST(range)
  );
  await sendChunks(
    phone,
    formatPaymentStatsWhatsApp(
      payRange,
      "Payments — orders booked in selected period"
    )
  );
  const payOrg = await fetchActiveOrdersPaymentSnapshot();
  await sendChunks(
    phone,
    formatPaymentStatsWhatsApp(payOrg, "All active orders — full snapshot")
  );
  const { text: alertText } = await fetchSystemAlertsSnapshot();
  await sendChunks(phone, alertText);
}

async function runDispatchReport(phone, range) {
  const [d, insights] = await Promise.all([
    fetchDispatchCompletedForRange(range),
    fetchOrderTransitionInsights(range),
  ]);
  await sendChunks(phone, formatDispatchReportWhatsApp(d));
  await sendChunks(phone, formatOrderTransitionInsightsWhatsApp(insights));

  if (isWatiConfigured()) {
    try {
      const rangeLabel = formatISTRangeLabel(range.start, range.end);
      const pdfBuffer = await generateOrderTransitionInsightsPdf({
        reportDateLabel: rangeLabel,
        bookedOrders: insights.bookedOrders,
        todayKey: insights.todayKey,
        currentStatuses: insights.currentStatuses,
        transitionMatrix: insights.transitionMatrix,
      });
      const filename = `transitions-${moment()
        .utcOffset(330)
        .format("YYYYMMDD-HHmmss")}.pdf`;
      await sendSessionFileMessage({
        whatsappNumber: phone,
        fileBuffer: pdfBuffer,
        filename,
        caption: `Order transitions · ${rangeLabel}`,
      });
      if (process.env.DO_SPACES_KEY) {
        void uploadToS3(pdfBuffer, filename).catch((e) =>
          console.warn("[report wizard] optional Spaces copy failed:", e?.message || e)
        );
      }
    } catch (e) {
      console.error("[report wizard] transitions PDF failed:", e?.message || e);
    }
  }
  const { text: alertText } = await fetchSystemAlertsSnapshot();
  await sendChunks(phone, alertText);
}

async function runBookingWithPdf(phone, data) {
  const text = formatBookingText(data);
  await sendChunks(phone, text);

  if (data.source === "bookings") {
    await sendChunks(
      phone,
      "💰 _Payment lines apply to **farmer orders** only. Set `BOOKING_REPORT_SOURCE=orders` for billable / collected / pending detail._"
    );
  } else {
    const payMatch = matchOrdersInBookingRangeIST(data.range);
    const pay = await fetchPaymentStatsForMatch(payMatch);
    await sendChunks(
      phone,
      formatPaymentStatsWhatsApp(
        pay,
        "Payments (same date range as booking report)"
      )
    );
  }

  if (!isWatiConfigured()) {
    return;
  }
  try {
    const rangeLabel = formatISTRangeLabel(data.range.start, data.range.end);
    const dataSourceLabel =
      data.source === "bookings"
        ? "Bookings collection (legacy)"
        : "Farmer orders (IST range)";
    let payAgg = null;
    if (data.source !== "bookings") {
      payAgg = await fetchPaymentStatsForMatch(
        matchOrdersInBookingRangeIST(data.range)
      );
    }
    const pdfBuffer = await generateTodayBookingPdf({
      reportDateLabel: rangeLabel,
      lineRows: data.lineRows,
      summaryRows: data.summaryRows,
      stats: data.stats,
      dataSourceLabel,
      bannerTitle: "Booking Report",
      topFarmers: data.topFarmers || [],
      topVillages: (data.topVillages || []).map((v) => ({
        name: v.name,
        quantity: v.quantity,
      })),
      paymentSnapshot: payAgg ? payAgg.summary : null,
      plantBarChart: plantTotalsForBarChart(data.summaryRows, 6),
    });
    const filename = `booking-${moment()
      .utcOffset(330)
      .format("YYYYMMDD-HHmmss")}.pdf`;
    await sendSessionFileMessage({
      whatsappNumber: phone,
      fileBuffer: pdfBuffer,
      filename,
      caption: `Booking ${rangeLabel}`,
    });
    if (process.env.DO_SPACES_KEY) {
      void uploadToS3(pdfBuffer, filename).catch((e) =>
        console.warn("[report wizard] optional Spaces copy failed:", e?.message || e)
      );
    }
  } catch (e) {
    console.error("[report wizard] PDF step failed:", e?.message || e);
    try {
      await sendSessionTextMessage({
        whatsappNumber: phone,
        messageText: `⚠️ PDF could not be sent: ${(e && e.message) || String(e)}. Check server logs / WATI session open.`,
      });
    } catch (_) {
      /* ignore */
    }
  }
}

async function runDeliveryWithPdf(phone, range, deliveryFilterMode) {
  const rangeLabel = formatISTRangeLabel(range.start, range.end);
  const modeKey =
    deliveryFilterMode && DELIVERY_MODE_CAPTION[deliveryFilterMode]
      ? deliveryFilterMode
      : "due_in_window";
  const modeHuman = DELIVERY_MODE_CAPTION[modeKey];

  const { segments } = await fetchDeliveryPipelineForWizard(range, modeKey);
  const payMatch = buildDeliveryPaymentMatchForWizard(range, modeKey);
  const payQueue = await fetchPaymentStatsForMatch(payMatch);

  const bodyParts = [
    "🚚 *Delivery report*",
    `_IST window: ${rangeLabel}_`,
    `_Scope: ${modeHuman}_`,
    "",
  ];
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    bodyParts.push(`*${i + 1}. ${seg.title}*`, "");
    bodyParts.push(
      formatDeliveryWhatsApp(
        { byPlant: seg.byPlant, totals: seg.totals },
        { skipBanner: true }
      )
    );
    bodyParts.push("", "──────────────", "");
  }
  bodyParts.push(
    formatPaymentStatsWhatsApp(
      payQueue,
      "Payments — same filter (ACCEPTED + FARM_READY)"
    ),
    "",
    "_PDF attached (one file; multiple sections if you chose “both”)._"
  );
  await sendChunks(phone, bodyParts.join("\n"));

  if (isWatiConfigured()) {
    try {
      const sessionLabel = `${rangeLabel} · ${modeHuman}`;
      const pdfBuffer = await generateDeliveryQueuePdf({
        reportDateLabel: sessionLabel,
        segments: segments.map((s) => ({
          title: s.title,
          byPlant: s.byPlant,
          totals: s.totals,
        })),
        paymentSnapshot: payQueue.summary,
      });
      const filename = `delivery-${moment()
        .utcOffset(330)
        .format("YYYYMMDD-HHmmss")}.pdf`;
      await sendSessionFileMessage({
        whatsappNumber: phone,
        fileBuffer: pdfBuffer,
        filename,
        caption: `Delivery queue · ${rangeLabel}`,
      });
      if (process.env.DO_SPACES_KEY) {
        void uploadToS3(pdfBuffer, filename).catch((e) =>
          console.warn("[report wizard] optional Spaces copy failed:", e?.message || e)
        );
      }
    } catch (e) {
      console.error("[report wizard] delivery PDF failed:", e?.message || e);
      try {
        await sendSessionTextMessage({
          whatsappNumber: phone,
          messageText: `⚠️ Delivery PDF could not be sent: ${(e && e.message) || String(e)}`,
        });
      } catch (_) {
        /* ignore */
      }
    }
  }

  await sendCompositeOpsAddOn(phone);
}

async function executeReportForRange(phone, reportType, range, extra = {}) {
  switch (reportType) {
    case "booking": {
      const data = await fetchBookingReportDataForDateRange(range);
      await runBookingWithPdf(phone, data);
      break;
    }
    case "delivery":
      await runDeliveryWithPdf(phone, range, extra.deliveryFilter);
      break;
    case "slots":
      await runSlotsReportWithPdf(phone, range);
      break;
    case "payment":
      await runPaymentReport(phone, range);
      break;
    case "dispatch":
      await runDispatchReport(phone, range);
      break;
    default:
      break;
  }
}

/**
 * @param {object} params
 * @param {object} [params.body] - raw webhook (optional; for future idempotency)
 * @param {string} params.message
 * @param {string} params.waId
 * @returns {Promise<{ handled: boolean }>}
 */
export async function processWhatsappReportWizard({ message, waId }) {
  const phone = normalizeWhatsAppNumberForWati(waId);
  if (!phone) {
    return { handled: false };
  }
  if (!isPhoneAllowedForReportWizard(phone)) {
    return { handled: false };
  }

  const text = String(message || "").trim();
  if (!text) {
    return { handled: false };
  }

  const key = phone.replace(/\D/g, "").slice(-10) || phone;
  const low = text.toLowerCase();

  if (["cancel", "stop", "exit", "0", "रद्द", "n"].includes(low)) {
    if (reportWizardState.has(key)) {
      reportWizardState.delete(key);
      if (isWatiConfigured()) {
        await sendSessionTextMessage({
          whatsappNumber: phone,
          messageText: "✅ Report flow cancelled. Send *get report* when you need it again.",
        });
      }
      return { handled: true };
    }
  }

  let state = reportWizardState.get(key);
  if (state && Date.now() - state.lastAt > STATE_TTL_MS) {
    reportWizardState.delete(key);
    state = null;
  }

  const entry = isReportEntry(text);

  if (!state && !entry) {
    return { handled: false };
  }

  if (!isWatiConfigured()) {
    console.warn(
      "[report wizard] WATI not configured — cannot send menu / report text"
    );
    if (entry) {
      return { handled: true };
    }
    return { handled: false };
  }

  if (entry) {
    const guessed = guessReportTypeFromText(text);
    if (guessed) {
      const isDel = guessed === "delivery";
      reportWizardState.set(key, {
        step: isDel ? "pick_delivery_window" : "pick_date",
        reportType: guessed,
        lastAt: Date.now(),
      });
      await sendSessionTextMessage({
        whatsappNumber: phone,
        messageText: isDel ? DELIVERY_WINDOW_PROMPT : DATE_PROMPT(guessed),
      });
      return { handled: true };
    }
    reportWizardState.set(key, { step: "pick_report", lastAt: Date.now() });
    await sendSessionTextMessage({ whatsappNumber: phone, messageText: MENU_TEXT });
    return { handled: true };
  }

  state.lastAt = Date.now();

  if (state.step === "pick_report") {
    const choice = parseReportTypeChoice(text);
    if (!choice) {
      await sendSessionTextMessage({
        whatsappNumber: phone,
        messageText:
          "Reply *1*–*5* using the menu below, or *cancel*.\n\n" + MENU_TEXT,
      });
      return { handled: true };
    }
    state.reportType = choice;
    if (choice === "delivery") {
      state.step = "pick_delivery_window";
      await sendSessionTextMessage({
        whatsappNumber: phone,
        messageText: DELIVERY_WINDOW_PROMPT,
      });
    } else {
      state.step = "pick_date";
      await sendSessionTextMessage({
        whatsappNumber: phone,
        messageText: DATE_PROMPT(choice),
      });
    }
    return { handled: true };
  }

  if (state.step === "pick_delivery_window") {
    const dr = parseDeliveryWindowChoice(text);
    if (!dr.ok) {
      await sendSessionTextMessage({
        whatsappNumber: phone,
        messageText:
          "Reply *1–4*, or type a date range on one line.\n\n" +
          DELIVERY_WINDOW_PROMPT,
      });
      return { handled: true };
    }
    if (dr.pendingCustom) {
      state.step = "delivery_custom_range";
      await sendSessionTextMessage({
        whatsappNumber: phone,
        messageText:
          "✏️ One line, for example:\n`2026-01-01 to 2026-01-20`\n(or DD-MM-YYYY to DD-MM-YYYY)",
      });
      return { handled: true };
    }
    state.pendingDeliveryRange = dr.range;
    state.step = "pick_delivery_filter";
    await sendSessionTextMessage({
      whatsappNumber: phone,
      messageText: DELIVERY_FILTER_PROMPT,
    });
    return { handled: true };
  }

  if (state.step === "delivery_custom_range") {
    const range = parseCustomRangeText(text);
    if (!range) {
      await sendSessionTextMessage({
        whatsappNumber: phone,
        messageText:
          "❗ Use `YYYY-MM-DD to YYYY-MM-DD` (IST days). Try again or *cancel*.",
      });
      return { handled: true };
    }
    state.pendingDeliveryRange = range;
    state.step = "pick_delivery_filter";
    await sendSessionTextMessage({
      whatsappNumber: phone,
      messageText: DELIVERY_FILTER_PROMPT,
    });
    return { handled: true };
  }

  if (state.step === "pick_delivery_filter") {
    const fl = parseDeliveryDueFilterChoice(text);
    if (!fl.ok) {
      await sendSessionTextMessage({
        whatsappNumber: phone,
        messageText:
          "Reply *1* (with due), *2* (without due), or *3* (both).\n\n" +
          DELIVERY_FILTER_PROMPT,
      });
      return { handled: true };
    }
    const range = state.pendingDeliveryRange;
    reportWizardState.delete(key);
    await executeReportForRange(phone, "delivery", range, {
      deliveryFilter: fl.mode,
    });
    return { handled: true };
  }

  if (state.step === "pick_date") {
    const dr = parseDateChoice(text);
    if (!dr.ok) {
      await sendSessionTextMessage({
        whatsappNumber: phone,
        messageText:
          "Reply *1–4*, or type `YYYY-MM-DD to YYYY-MM-DD` on one line.\n\n" +
          DATE_PROMPT(state.reportType),
      });
      return { handled: true };
    }
    if (dr.pendingCustom) {
      state.step = "custom_range";
      await sendSessionTextMessage({
        whatsappNumber: phone,
        messageText:
          "✏️ One line, for example:\n`2026-01-01 to 2026-01-20`\n(or DD-MM-YYYY to DD-MM-YYYY)",
      });
      return { handled: true };
    }
    reportWizardState.delete(key);
    await executeReportForRange(phone, state.reportType, dr.range);
    return { handled: true };
  }

  if (state.step === "custom_range") {
    const range = parseCustomRangeText(text);
    if (!range) {
      await sendSessionTextMessage({
        whatsappNumber: phone,
        messageText:
          "❗ Use `YYYY-MM-DD to YYYY-MM-DD` (IST days). Try again or *cancel*.",
      });
      return { handled: true };
    }
    reportWizardState.delete(key);
    await executeReportForRange(phone, state.reportType, range);
    return { handled: true };
  }

  return { handled: false };
}

/**
 * Used from webhooks: parse body and run wizard (same triggers as handleWhatsAppWebhook message).
 */
const wizardProcessingIds = new Set();
const wizardSeenMessageIds = new Map();
const WIZARD_MSG_ID_TTL_MS = 25 * 60 * 1000;

function pruneWizardMessageIds() {
  const now = Date.now();
  for (const [id, t] of wizardSeenMessageIds) {
    if (now - t > WIZARD_MSG_ID_TTL_MS) {
      wizardSeenMessageIds.delete(id);
    }
  }
}

export async function runWhatsappReportWizardFromWebhookBody(body) {
  const msgId = extractInboundMessageId(body);
  if (msgId) {
    pruneWizardMessageIds();
    if (
      wizardSeenMessageIds.has(msgId) ||
      wizardProcessingIds.has(msgId)
    ) {
      return { handled: true, duplicate: true };
    }
    wizardProcessingIds.add(msgId);
  }
  try {
    const { text, waId } = extractInboundMessage(body);
    const result = await processWhatsappReportWizard({ message: text, waId });
    if (msgId && result.handled) {
      wizardSeenMessageIds.set(msgId, Date.now());
    }
    return result;
  } finally {
    if (msgId) {
      wizardProcessingIds.delete(msgId);
    }
  }
}

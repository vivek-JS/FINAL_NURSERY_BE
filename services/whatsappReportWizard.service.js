import moment from "moment";
import {
  fetchBookingReportDataForDateRange,
  formatISTRangeLabel,
} from "./reportService.js";
import { generateTodayBookingPdf } from "./pdfService.js";
import { sendSessionFileMessage, sendSessionTextMessage } from "./watiService.js";
import { uploadToS3 } from "./uploadService.js";
import {
  normalizeWhatsAppNumberForWati,
  extractInboundMessage,
} from "../utility/watiInboundPayload.js";
import { isWatiConfigured } from "../config/wati.config.js";
import {
  fetchDeliveryPipelineByPlant,
  formatDeliveryWhatsApp,
  fetchFutureSlotHighlights,
  fetchSystemAlertsSnapshot,
  fetchActiveOrdersPaymentSnapshot,
  fetchPaymentStatsForMatch,
  formatPaymentStatsWhatsApp,
  matchOrdersInBookingRangeIST,
  splitForWhatsApp,
} from "./whatsappReportData.service.js";
import {
  isReportEntry,
  guessReportTypeFromText,
  parseReportTypeChoice,
  parseDateChoice,
  parseCustomRangeText,
} from "../utility/whatsappReportWizardParsers.js";

const STATE_TTL_MS = 15 * 60 * 1000;

/** @type {Map<string, object>} */
const reportWizardState = new Map();

const MENU_TEXT = `📋 *Nursery reports*
Reply with a number:
*1* — Booking (farmer orders in a date range)
*2* — Delivery queue (ACCEPTED + FARM_READY, plant-wise)
*3* — Sowing (coming soon)

Or *cancel* to stop.`;

const DATE_PROMPT = (typeLabel) => `📅 *Date range* — ${typeLabel}
*1* — Today (IST)
*2* — Yesterday
*3* — Last 7 days (rolling, ends today)
*4* — Custom (you will be asked to type two dates)

Reply with 1–4, or *cancel*.`;

const SOWING_PLACEHOLDER = `🌱 *Sowing report* is not automated yet.
We will add batch / slot sowing stats here. For now use *1* (Booking) or *2* (Delivery).`;

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

  lines.push("", "🌿 *Plant → subtype* (summary) — see attached PDF.");
  return lines.join("\n");
}

async function sendCompositeOpsAddOn(phone) {
  const [slots, alerts, payOrg] = await Promise.all([
    fetchFutureSlotHighlights(),
    fetchSystemAlertsSnapshot(),
    fetchActiveOrdersPaymentSnapshot(),
  ]);
  const payText = formatPaymentStatsWhatsApp(
    payOrg,
    "All active orders — full payment snapshot"
  );
  await sendChunks(phone, `${payText}\n\n${slots.text}\n\n${alerts.text}`);
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
    const pdfBuffer = await generateTodayBookingPdf({
      reportDateLabel: rangeLabel,
      lineRows: data.lineRows,
      summaryRows: data.summaryRows,
      stats: data.stats,
      dataSourceLabel,
      bannerTitle: "Booking Report",
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

async function runDeliveryText(phone) {
  const [d, payQueue] = await Promise.all([
    fetchDeliveryPipelineByPlant(),
    fetchPaymentStatsForMatch({
      orderStatus: { $in: ["ACCEPTED", "FARM_READY"] },
    }),
  ]);
  const body = [
    "_Delivery queue is always a *live snapshot* (not filtered by date). The date menu applies to **Booking** reports only._",
    "",
    formatDeliveryWhatsApp(d),
    "",
    formatPaymentStatsWhatsApp(
      payQueue,
      "Payments — delivery queue (ACCEPTED + FARM_READY only)"
    ),
  ].join("\n");
  await sendChunks(phone, body);
  await sendCompositeOpsAddOn(phone);
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
    if (guessed === "sowing") {
      await sendSessionTextMessage({
        whatsappNumber: phone,
        messageText: SOWING_PLACEHOLDER,
      });
      return { handled: true };
    }
    if (guessed === "booking" || guessed === "delivery") {
      reportWizardState.set(key, {
        step: "pick_date",
        reportType: guessed,
        lastAt: Date.now(),
      });
      await sendSessionTextMessage({
        whatsappNumber: phone,
        messageText: DATE_PROMPT(
          guessed === "booking" ? "Booking" : "Delivery snapshot"
        ),
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
          "Please reply *1*, *2*, or *3* — or *cancel*.\n\n" + MENU_TEXT,
      });
      return { handled: true };
    }
    if (choice === "sowing") {
      reportWizardState.delete(key);
      await sendSessionTextMessage({
        whatsappNumber: phone,
        messageText: SOWING_PLACEHOLDER,
      });
      return { handled: true };
    }
    state.reportType = choice;
    state.step = "pick_date";
    await sendSessionTextMessage({
      whatsappNumber: phone,
      messageText: DATE_PROMPT(
        choice === "booking" ? "Booking" : "Delivery snapshot"
      ),
    });
    return { handled: true };
  }

  if (state.step === "pick_date") {
    const dr = parseDateChoice(text);
    if (!dr.ok) {
      await sendSessionTextMessage({
        whatsappNumber: phone,
        messageText:
          "Could not understand. Reply *1–4*, or type `YYYY-MM-DD to YYYY-MM-DD`.\n\n" +
          DATE_PROMPT(state.reportType === "booking" ? "Booking" : "Delivery"),
      });
      return { handled: true };
    }
    if (dr.pendingCustom) {
      state.step = "custom_range";
      await sendSessionTextMessage({
        whatsappNumber: phone,
        messageText:
          "✏️ Send *one line* with start and end date:\n`2026-01-01 to 2026-01-20`\n(or DD-MM-YYYY to DD-MM-YYYY)",
      });
      return { handled: true };
    }
    reportWizardState.delete(key);
    if (state.reportType === "booking") {
      const data = await fetchBookingReportDataForDateRange(dr.range);
      await runBookingWithPdf(phone, data);
      await sendCompositeOpsAddOn(phone);
    } else {
      await runDeliveryText(phone);
    }
    return { handled: true };
  }

  if (state.step === "custom_range") {
    const range = parseCustomRangeText(text);
    if (!range) {
      await sendSessionTextMessage({
        whatsappNumber: phone,
        messageText:
          "❗ Use format `YYYY-MM-DD to YYYY-MM-DD` (IST calendar days). Try again or *cancel*.",
      });
      return { handled: true };
    }
    reportWizardState.delete(key);
    if (state.reportType === "booking") {
      const data = await fetchBookingReportDataForDateRange(range);
      await runBookingWithPdf(phone, data);
      await sendCompositeOpsAddOn(phone);
    } else {
      await runDeliveryText(phone);
    }
    return { handled: true };
  }

  return { handled: false };
}

/**
 * Used from webhooks: parse body and run wizard (same triggers as handleWhatsAppWebhook message).
 */
export async function runWhatsappReportWizardFromWebhookBody(body) {
  const { text, waId } = extractInboundMessage(body);
  return processWhatsappReportWizard({ message: text, waId });
}

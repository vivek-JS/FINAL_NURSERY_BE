import moment from "moment";
import {
  fetchBookingReportDataForDateRange,
  formatISTRangeLabel,
  formatPlantSubtypeBlocksForWhatsApp,
} from "./reportService.js";
import {
  generateTodayBookingPdf,
  generateCentralDeliveryPdf,
  generateAvailabilityPdf,
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
  fetchPaymentStatsForMatch,
  formatPaymentStatsWhatsApp,
  matchOrdersInBookingRangeIST,
  splitForWhatsApp,
} from "./whatsappReportData.service.js";
import {
  fetchCentralDeliveryReport,
  formatCentralDeliveryWhatsApp,
} from "./whatsappReportCentralDelivery.service.js";
import {
  fetchPlantsForAvailabilityWizard,
  formatPlantMonthAvailabilityWhatsApp,
  formatMonthAvailabilityWhatsApp,
  upcomingMonthsForWizard,
  buildMonthPromptText,
  buildPlantPromptText,
  resolveMonthFromChoice,
  resolvePlantFromChoice,
} from "./whatsappReportAvailability.service.js";
import { fetchCentralAvailabilityReport } from "./whatsappReportCentralAvailability.service.js";
import {
  isReportEntry,
  guessReportTypeFromText,
  parseReportTypeChoice,
  parseDateChoice,
  parseCustomRangeText,
  parseDeliveryWindowChoice,
  parseAvailabilityModeChoice,
} from "../utility/whatsappReportWizardParsers.js";
import { isPhoneAllowedForReportWizard } from "../utility/whatsappReportWizardAllowlist.js";
import { isOrderBotTrigger } from "../utility/whatsappOrderTriggers.js";

const STATE_TTL_MS = 15 * 60 * 1000;

/** @type {Map<string, object>} */
const reportWizardState = new Map();

const MENU_TEXT = `📋 *Nursery reports*
Reply with a number:
*1* — Booking (PDF + charts, date range)
*2* — Delivery (central MIS: totals, plant/subtype, past due + PDF)
*3* — Availability (plant or month-wise slot stock)

_Type *cancel* anytime._`;

const DELIVERY_WINDOW_PROMPT = `📅 *Delivery — pick planning window (IST)*
*1* — Today
*2* — Next 7 days (today through +6 days)
*3* — Next 14 days (today through +13 days)
*4* — Custom (you’ll type two dates next)

Reply *1–4*, or *cancel*.`;

const AVAILABILITY_MODE_PROMPT = `📦 *Availability — how to view?*
*1* — *By plant* — pick plant, then month
*2* — *By month* — pick month, see all plants

Reply *1* or *2*, or *cancel*.`;

function datePromptTitle(reportType) {
  const m = {
    booking: "Booking",
    delivery: "Delivery",
    availability: "Availability",
  };
  return m[reportType] || "Report";
}

const DATE_PROMPT = (reportType) => `📅 *Pick dates (IST)* — ${datePromptTitle(reportType)}
*1* — Today
*2* — Yesterday
*3* — Last 7 days (rolling)
*4* — Custom (you’ll type two dates next)

Reply *1–4*, or *cancel*.`;

async function sendChunks(whatsappNumber, messageText) {
  const parts = splitForWhatsApp(messageText);
  for (const chunk of parts) {
    await sendSessionTextMessage({ whatsappNumber, messageText: chunk });
  }
}

async function sendPdfToPhone(phone, pdfBuffer, filename, caption) {
  await sendSessionFileMessage({
    whatsappNumber: phone,
    fileBuffer: pdfBuffer,
    filename,
    caption,
  });
  if (process.env.DO_SPACES_KEY) {
    void uploadToS3(pdfBuffer, filename).catch((e) =>
      console.warn("[report wizard] optional Spaces copy failed:", e?.message || e)
    );
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
    await sendPdfToPhone(phone, pdfBuffer, filename, `Booking ${rangeLabel}`);
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

async function runDeliveryWithPdf(phone, range) {
  try {
    const { data, rangeLabel } = await fetchCentralDeliveryReport(range);
    const text = formatCentralDeliveryWhatsApp({ data, rangeLabel });
    await sendChunks(phone, text);

    if (isWatiConfigured()) {
      const pdfBuffer = await generateCentralDeliveryPdf({
        reportDateLabel: rangeLabel,
        varietyRows: data.varietyTable || [],
        varietyTotals: data.varietyTotals || {},
        dueSummary: data.dueSummary || {},
      });
      const filename = `delivery-${moment()
        .utcOffset(330)
        .format("YYYYMMDD-HHmmss")}.pdf`;
      await sendPdfToPhone(
        phone,
        pdfBuffer,
        filename,
        `Delivery · ${rangeLabel} · central MIS`
      );
    }
  } catch (e) {
    console.error("[report wizard] central delivery failed:", e?.message || e);
    await sendChunks(
      phone,
      `⚠️ Delivery report failed: ${(e && e.message) || String(e)}`
    );
  }
}

async function runAvailabilityReport(phone, { mode, plant, month, year }) {
  try {
    const data = await fetchCentralAvailabilityReport({
      year,
      month: month.name,
      plantId: mode === "by_plant" ? plant.id : undefined,
    });

    let text;
    let pdfTitle;
    let pdfLabel;
    if (mode === "by_plant") {
      text = formatPlantMonthAvailabilityWhatsApp({
        plantName: plant.name,
        month: month.name,
        year,
        data,
      });
      pdfTitle = `Availability — ${plant.name}`;
      pdfLabel = `${plant.name} · ${month.name} ${year}`;
    } else {
      text = formatMonthAvailabilityWhatsApp({
        month: month.name,
        year,
        data,
      });
      pdfTitle = `Availability — ${month.name} ${year}`;
      pdfLabel = `${month.name} ${year} · all plants`;
    }

    await sendChunks(phone, text);

    if (isWatiConfigured()) {
      const pdfBuffer = await generateAvailabilityPdf({
        reportTitle: pdfTitle,
        reportDateLabel: pdfLabel,
        summary: data.summary,
        rows: data.rows,
      });
      const filename = `availability-${moment()
        .utcOffset(330)
        .format("YYYYMMDD-HHmmss")}.pdf`;
      await sendPdfToPhone(phone, pdfBuffer, filename, pdfLabel);
    }
  } catch (e) {
    console.error("[report wizard] availability failed:", e?.message || e);
    await sendChunks(
      phone,
      `⚠️ Availability report failed: ${(e && e.message) || String(e)}`
    );
  }
}

async function executeReportForRange(phone, reportType, range) {
  switch (reportType) {
    case "booking": {
      const data = await fetchBookingReportDataForDateRange(range);
      await runBookingWithPdf(phone, data);
      break;
    }
    case "delivery":
      await runDeliveryWithPdf(phone, range);
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

  if (isOrderBotTrigger(text)) {
    if (reportWizardState.has(key)) {
      reportWizardState.delete(key);
    }
    return { handled: false };
  }

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
      const isAvail = guessed === "availability";
      if (isAvail) {
        reportWizardState.set(key, {
          step: "pick_availability_mode",
          reportType: "availability",
          lastAt: Date.now(),
        });
        await sendSessionTextMessage({
          whatsappNumber: phone,
          messageText: AVAILABILITY_MODE_PROMPT,
        });
        return { handled: true };
      }
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
          "Reply *1*–*3* using the menu below, or *cancel*.\n\n" + MENU_TEXT,
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
    } else if (choice === "availability") {
      state.step = "pick_availability_mode";
      await sendSessionTextMessage({
        whatsappNumber: phone,
        messageText: AVAILABILITY_MODE_PROMPT,
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
    reportWizardState.delete(key);
    await runDeliveryWithPdf(phone, dr.range);
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
    reportWizardState.delete(key);
    await runDeliveryWithPdf(phone, range);
    return { handled: true };
  }

  if (state.step === "pick_availability_mode") {
    const mode = parseAvailabilityModeChoice(text);
    if (!mode) {
      await sendSessionTextMessage({
        whatsappNumber: phone,
        messageText:
          "Reply *1* (by plant) or *2* (by month).\n\n" + AVAILABILITY_MODE_PROMPT,
      });
      return { handled: true };
    }
    state.availabilityMode = mode;
    state.monthOptions = upcomingMonthsForWizard(8);
    if (mode === "by_plant") {
      const plants = await fetchPlantsForAvailabilityWizard();
      if (!plants.length) {
        reportWizardState.delete(key);
        await sendSessionTextMessage({
          whatsappNumber: phone,
          messageText: "❌ No plants found in CMS.",
        });
        return { handled: true };
      }
      state.plants = plants;
      state.step = "pick_availability_plant";
      await sendSessionTextMessage({
        whatsappNumber: phone,
        messageText: buildPlantPromptText(plants),
      });
    } else {
      state.step = "pick_availability_month";
      await sendSessionTextMessage({
        whatsappNumber: phone,
        messageText: buildMonthPromptText(state.monthOptions),
      });
    }
    return { handled: true };
  }

  if (state.step === "pick_availability_plant") {
    const plant = resolvePlantFromChoice(text, state.plants || []);
    if (!plant) {
      await sendSessionTextMessage({
        whatsappNumber: phone,
        messageText:
          "Reply with a plant number from the list, or *cancel*.\n\n" +
          buildPlantPromptText(state.plants || []),
      });
      return { handled: true };
    }
    state.selectedPlant = plant;
    state.step = "pick_availability_month";
    await sendSessionTextMessage({
      whatsappNumber: phone,
      messageText: buildMonthPromptText(state.monthOptions || upcomingMonthsForWizard(8)),
    });
    return { handled: true };
  }

  if (state.step === "pick_availability_month") {
    const month = resolveMonthFromChoice(text, state.monthOptions || []);
    if (!month) {
      await sendSessionTextMessage({
        whatsappNumber: phone,
        messageText:
          "Reply with a month number or name, or *cancel*.\n\n" +
          buildMonthPromptText(state.monthOptions || upcomingMonthsForWizard(8)),
      });
      return { handled: true };
    }
    const mode = state.availabilityMode;
    const plant = state.selectedPlant;
    reportWizardState.delete(key);
    await runAvailabilityReport(phone, {
      mode,
      plant,
      month,
      year: month.year,
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

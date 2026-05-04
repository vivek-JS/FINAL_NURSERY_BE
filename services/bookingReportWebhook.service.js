import moment from "moment";
import {
  shouldGenerateTodayBookingReport,
  fetchTodayBookingReportData,
  getTodayRangeIST,
  pickReportCaption,
  formatBookingFiguresWhatsApp,
} from "./reportService.js";
import {
  fetchPaymentStatsForMatch,
  formatPaymentStatsWhatsApp,
  matchOrdersInBookingRangeIST,
} from "./whatsappReportData.service.js";
import { generateTodayBookingPdf } from "./pdfService.js";
import { sendSessionFileMessage, sendSessionTextMessage } from "./watiService.js";
import { uploadToS3 } from "./uploadService.js";
import {
  extractInboundMessage,
  normalizeWhatsAppNumberForWati,
} from "../utility/watiInboundPayload.js";
import { isWatiConfigured } from "../config/wati.config.js";
import {
  shouldSkipDuplicateBookingReport,
  recordBookingReportSuccessfullySent,
} from "./bookingReportDedupe.service.js";

/**
 * If the inbound message asks for today's booking report, build PDF, upload, send via WATI.
 * Safe to call on every opt-in webhook POST; no-ops when phrases don't match.
 *
 * @param {object} body - req.body from WATI
 * @returns {Promise<{ sent?: boolean, skipped?: string }>}
 */
export async function runTodayBookingPdfJob(body) {
  if (!body || typeof body !== "object") {
    return { skipped: "no_body" };
  }

  const { text, waId } = extractInboundMessage(body);
  if (!shouldGenerateTodayBookingReport(text)) {
    return { skipped: "no_trigger" };
  }

  if (shouldSkipDuplicateBookingReport(body)) {
    return { skipped: "duplicate_webhook" };
  }

  const phone = normalizeWhatsAppNumberForWati(waId);
  if (!phone) {
    console.warn(
      "[booking report] Trigger matched but waId missing or invalid:",
      JSON.stringify(body).slice(0, 500)
    );
    return { skipped: "no_wa_id" };
  }

  console.log(
    `[booking report] Trigger matched — waId=${waId} normalized=${phone} text="${String(text).slice(0, 80)}"`
  );

  if (!isWatiConfigured()) {
    console.error(
      "[booking report] WATI not configured on server: set WATI_BASE_URL (or WATI_URL) and WATI_TOKEN in .env — no WhatsApp reply will be sent."
    );
    return { skipped: "wati_not_configured" };
  }

  const reportDateLabel = moment().utcOffset(330).format("YYYY-MM-DD [(IST)]");
  const { lineRows, summaryRows, stats, source: dataSource } =
    await fetchTodayBookingReportData();
  const dataSourceKey = dataSource === "bookings" ? "bookings" : "orders";
  const dataSourceLabel =
    dataSourceKey === "bookings"
      ? "Bookings collection (legacy)"
      : "Farmer orders (IST)";

  const figuresText = formatBookingFiguresWhatsApp(
    reportDateLabel,
    stats,
    summaryRows,
    dataSourceKey
  );
  let textOk = false;
  try {
    await sendSessionTextMessage({
      whatsappNumber: phone,
      messageText: figuresText,
    });
    textOk = true;
    console.log(`[booking report] Sent figures text to ${phone}`);
  } catch (err) {
    console.error("[booking report] Figures text failed:", err?.message || err);
  }

  if (dataSourceKey === "orders") {
    try {
      const range = getTodayRangeIST();
      const pay = await fetchPaymentStatsForMatch(
        matchOrdersInBookingRangeIST(range)
      );
      await sendSessionTextMessage({
        whatsappNumber: phone,
        messageText: formatPaymentStatsWhatsApp(
          pay,
          "Payments (today IST — same scope as this booking report)"
        ),
      });
    } catch (e) {
      console.error("[booking report] payment summary failed:", e?.message || e);
    }
  }

  try {
    const pdfBuffer = await generateTodayBookingPdf({
      reportDateLabel,
      lineRows,
      summaryRows,
      stats,
      dataSourceLabel,
    });

    const filename = `today-booking-${moment()
      .utcOffset(330)
      .format("YYYYMMDD-HHmmss")}.pdf`;
    const caption = pickReportCaption(text);

    await sendSessionFileMessage({
      whatsappNumber: phone,
      fileBuffer: pdfBuffer,
      filename,
      caption,
    });

    if (process.env.DO_SPACES_KEY) {
      void uploadToS3(pdfBuffer, filename).catch((e) =>
        console.warn("[booking report] optional Spaces copy failed:", e?.message || e)
      );
    }

    console.log(
      `[booking report] Sent PDF to ${phone} (${stats.bookingLines} lines, total qty ${stats.grandTotal})`
    );
    recordBookingReportSuccessfullySent(body);
    return { sent: true };
  } catch (err) {
    console.error(
      "[booking report] PDF/upload/file-message failed:",
      err?.message || err
    );
    if (textOk) {
      console.warn(
        "[booking report] Figures text was sent; PDF step failed — check DO_SPACES_* and public file URL for WATI."
      );
    }
    throw err;
  }
}

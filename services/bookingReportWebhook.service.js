import moment from "moment";
import {
  shouldGenerateTodayBookingReport,
  fetchTodayBookingReportData,
  pickReportCaption,
  formatBookingFiguresWhatsApp,
} from "./reportService.js";
import { generateTodayBookingPdf } from "./pdfService.js";
import { uploadToS3 } from "./uploadService.js";
import { sendSessionFileMessage, sendSessionTextMessage } from "./watiService.js";
import {
  extractInboundMessage,
  normalizeWhatsAppNumberForWati,
} from "../utility/watiInboundPayload.js";

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

  const phone = normalizeWhatsAppNumberForWati(waId);
  if (!phone) {
    console.warn(
      "[booking report] Trigger matched but waId missing or invalid:",
      JSON.stringify(body).slice(0, 500)
    );
    return { skipped: "no_wa_id" };
  }

  const reportDateLabel = moment().utcOffset(330).format("YYYY-MM-DD [(IST)]");
  const { lineRows, summaryRows, stats } = await fetchTodayBookingReportData();

  const figuresText = formatBookingFiguresWhatsApp(
    reportDateLabel,
    stats,
    summaryRows
  );
  try {
    await sendSessionTextMessage({
      whatsappNumber: phone,
      messageText: figuresText,
    });
    console.log(`[booking report] Sent figures text to ${phone}`);
  } catch (err) {
    console.error("[booking report] Figures text failed (continuing with PDF):", err?.message || err);
  }

  const pdfBuffer = await generateTodayBookingPdf({
    reportDateLabel,
    lineRows,
    summaryRows,
    stats,
  });

  const filename = `today-booking-${moment()
    .utcOffset(330)
    .format("YYYYMMDD-HHmmss")}.pdf`;
  const fileUrl = await uploadToS3(pdfBuffer, filename);
  const caption = pickReportCaption(text);

  await sendSessionFileMessage({
    whatsappNumber: phone,
    fileUrl,
    caption,
  });

  console.log(
    `[booking report] Sent PDF to ${phone} (${stats.bookingLines} lines, total qty ${stats.grandTotal})`
  );
  return { sent: true };
}

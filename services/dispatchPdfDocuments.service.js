import PDFDocument from "pdfkit";
import { htmlToPdfBuffer } from "./htmlToPdf.service.js";
import {
  mapDispatchToChallanPages,
  mapDispatchToRamInvoicePages,
  renderDeliveryChallanDocument,
  renderRamBiotechInvoiceDocument,
  resolveChallanInvoiceLabelForPdf,
} from "../../shared/dispatch-documents/index.js";

export { resolveChallanInvoiceLabelForPdf };

function plainTextDeliveryChallanFallback(dispatch) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const doc = new PDFDocument({ size: "A4", margin: 40, info: { Title: "Delivery Challan" } });
    doc.on("data", (c) => chunks.push(c));
    doc.on("error", reject);
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.fontSize(16).text("Delivery Challan", { underline: true });
    doc.fontSize(10).text(`Transport ID: ${dispatch.transportId ?? "—"}`);
    doc.text(`Driver: ${dispatch.driverName || "—"}    Vehicle: ${dispatch.vehicleName || "—"}`);
    doc.end();
  });
}

function plainTextInvoiceFallback(dispatch) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const doc = new PDFDocument({ size: "A4", margin: 40, info: { Title: "Complete Invoice" } });
    doc.on("data", (c) => chunks.push(c));
    doc.on("error", reject);
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.fontSize(16).text("Ram Biotech Invoice", { underline: true });
    doc.fontSize(10).text(`Transport: ${dispatch.transportId ?? "—"}`);
    doc.end();
  });
}

/**
 * @param {object} dispatch — lean Dispatch with populated orderIds
 */
export async function buildDeliveryChallanPdfBuffer(dispatch) {
  const pages = mapDispatchToChallanPages(dispatch);
  if (!pages.length) {
    return plainTextDeliveryChallanFallback(dispatch);
  }
  const html = renderDeliveryChallanDocument(
    pages,
    `Delivery Challans — ${dispatch.transportId ?? ""}`
  );
  try {
    return await htmlToPdfBuffer(html, { width: "148mm", height: "210mm" });
  } catch (err) {
    console.warn("[buildDeliveryChallanPdfBuffer] HTML PDF failed, using fallback:", err?.message);
    return plainTextDeliveryChallanFallback(dispatch);
  }
}

/**
 * Ram Biotech complete invoice — one A4 page per order.
 * @param {object} dispatch — lean; transportStatus should be DELIVERED (enforced by route).
 */
export async function buildCompleteInvoicePdfBuffer(dispatch, options = {}) {
  const pages = mapDispatchToRamInvoicePages(dispatch, undefined, options);
  if (!pages.length) {
    return plainTextInvoiceFallback(dispatch);
  }
  const html = renderRamBiotechInvoiceDocument(
    pages,
    `Invoice — ${dispatch.transportId ?? ""}`
  );
  try {
    return await htmlToPdfBuffer(html, { format: "A4", margin: { top: "8mm", right: "8mm", bottom: "8mm", left: "8mm" } });
  } catch (err) {
    console.warn("[buildCompleteInvoicePdfBuffer] HTML PDF failed, using fallback:", err?.message);
    return plainTextInvoiceFallback(dispatch);
  }
}

/**
 * Credit-note / purchase-return PDF invoices (pdfkit).
 * Keep under 700 lines — shared layout helpers + two builders.
 */
import PDFDocument from "pdfkit";
import AgriSalesReturnRequest from "../models/agriSalesReturnRequest.model.js";
import PurchaseReturn from "../models/purchaseReturn.model.js";
import Merchant from "../models/merchant.model.js";

function money(n) {
  return Number(n || 0).toLocaleString("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function formatDate(v) {
  if (!v) return "—";
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function bufferFromDoc(doc) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("error", reject);
    doc.on("end", () => resolve(Buffer.concat(chunks)));
  });
}

async function nextInvoiceNumber(Model, field, prefix) {
  const yn = new Date().getFullYear().toString().slice(-2);
  const fullPrefix = `${prefix}${yn}`;
  const last = await Model.findOne({ [field]: new RegExp(`^${fullPrefix}`) })
    .sort({ [field]: -1 })
    .select(field)
    .lean();
  let seq = 1;
  if (last?.[field]) {
    const n = parseInt(String(last[field]).replace(/\D/g, "").slice(-5), 10);
    if (Number.isFinite(n)) seq = n + 1;
  }
  return `${fullPrefix}${String(seq).padStart(5, "0")}`;
}

function drawHeader(doc, { title, subtitle, accent }) {
  doc.rect(0, 0, doc.page.width, 72).fill(accent);
  doc.fillColor("#ffffff").fontSize(18).font("Helvetica-Bold").text(title, 40, 22, { width: 360 });
  doc.fontSize(10).font("Helvetica").fillColor("#e2e8f0").text(subtitle, 40, 46, { width: 360 });
}

function drawMetaBox(doc, y, rows) {
  const boxX = 40;
  const boxW = doc.page.width - 80;
  const rowH = 16;
  const h = 14 + rows.length * rowH;
  doc.roundedRect(boxX, y, boxW, h, 6).fillAndStroke("#f8fafc", "#e2e8f0");
  let cy = y + 10;
  for (const [label, value] of rows) {
    doc.fillColor("#64748b").fontSize(8).font("Helvetica").text(label, boxX + 12, cy, { width: 110 });
    doc.fillColor("#0f172a").font("Helvetica-Bold").fontSize(9).text(String(value || "—"), boxX + 130, cy, {
      width: boxW - 150,
    });
    cy += rowH;
  }
  return y + h + 14;
}

function drawTable(doc, y, columns, rows, { accent }) {
  const pageW = doc.page.width - 80;
  const widths = columns.map((c) => c.width);
  const startX = 40;

  const drawRow = (cells, opts = {}) => {
    let x = startX;
    const h = opts.header ? 22 : 18;
    if (opts.header) {
      doc.rect(startX, y, pageW, h).fill(accent);
    } else if (opts.alt) {
      doc.rect(startX, y, pageW, h).fill("#f1f5f9");
    }
    for (let i = 0; i < cells.length; i++) {
      const col = columns[i];
      doc
        .fillColor(opts.header ? "#ffffff" : "#0f172a")
        .font(opts.header || col.bold ? "Helvetica-Bold" : "Helvetica")
        .fontSize(opts.header ? 8 : 8)
        .text(String(cells[i] ?? ""), x + 4, y + 5, {
          width: widths[i] - 8,
          align: col.align || "left",
        });
      x += widths[i];
    }
    y += h;
    if (y > doc.page.height - 80) {
      doc.addPage();
      y = 40;
    }
  };

  drawRow(
    columns.map((c) => c.label),
    { header: true }
  );
  rows.forEach((r, idx) => drawRow(r, { alt: idx % 2 === 1 }));
  return y + 8;
}

function drawTotals(doc, y, items, accent) {
  const boxW = 220;
  const boxX = doc.page.width - 40 - boxW;
  const h = 12 + items.length * 18;
  doc.roundedRect(boxX, y, boxW, h, 6).fillAndStroke("#fff7ed", accent);
  let cy = y + 10;
  items.forEach(([label, value, strong]) => {
    doc.fillColor("#64748b").font("Helvetica").fontSize(8).text(label, boxX + 12, cy, { width: 90 });
    doc
      .fillColor(strong ? accent : "#0f172a")
      .font(strong ? "Helvetica-Bold" : "Helvetica")
      .fontSize(strong ? 11 : 9)
      .text(value, boxX + 100, cy, { width: boxW - 112, align: "right" });
    cy += 18;
  });
  return y + h + 16;
}

function drawFooter(doc, note) {
  const y = doc.page.height - 48;
  doc
    .moveTo(40, y)
    .lineTo(doc.page.width - 40, y)
    .strokeColor("#e2e8f0")
    .stroke();
  doc
    .fillColor("#94a3b8")
    .fontSize(8)
    .font("Helvetica")
    .text(note || "Computer-generated return invoice · Ram Biotech / Ram Agri ERP", 40, y + 10, {
      width: doc.page.width - 80,
      align: "center",
    });
}

/**
 * Sale return credit note PDF.
 */
export async function buildSaleReturnInvoicePdf(returnId) {
  const docRow = await AgriSalesReturnRequest.findById(returnId)
    .populate("dealer", "name phone")
    .populate("requestedBy", "name")
    .populate("reviewedBy", "name")
    .populate("orderId", "orderNumber customerName customerMobile merchant")
    .lean();
  if (!docRow) {
    return { ok: false, error: "Sell return not found", status: 404 };
  }
  const st = String(docRow.status || "").toUpperCase();
  if (["REJECTED", "CANCELLED"].includes(st)) {
    return { ok: false, error: "Cannot invoice a rejected/cancelled return", status: 400 };
  }

  let invoiceNumber = docRow.invoiceNumber;
  if (!invoiceNumber) {
    invoiceNumber = await nextInvoiceNumber(AgriSalesReturnRequest, "invoiceNumber", "SRI");
    await AgriSalesReturnRequest.updateOne(
      { _id: docRow._id },
      { $set: { invoiceNumber, invoiceGeneratedAt: new Date() } }
    );
  }

  let partyName =
    docRow.dealer?.name ||
    docRow.orderId?.customerName ||
    (docRow.affectedOrders || []).map((o) => o.customerName).filter(Boolean)[0] ||
    "Customer";

  // Merchant batch — resolve merchant if noted on first order
  const firstOrderMerchant = docRow.orderId?.merchant;
  if (firstOrderMerchant) {
    const m = await Merchant.findById(firstOrderMerchant).select("name phone").lean();
    if (m?.name) partyName = m.name;
  }

  const accent = "#c2410c";
  const pdf = new PDFDocument({ size: "A4", margin: 40, info: { Title: `Sale Return ${invoiceNumber}` } });
  const done = bufferFromDoc(pdf);

  drawHeader(pdf, {
    title: "SALE RETURN INVOICE",
    subtitle: "Ram Agri Input · Credit note",
    accent,
  });

  pdf
    .fillColor(accent)
    .font("Helvetica-Bold")
    .fontSize(11)
    .text(invoiceNumber, 40, 86, { align: "right", width: pdf.page.width - 80 });

  let y = 110;
  y = drawMetaBox(pdf, y, [
    ["Invoice #", invoiceNumber],
    ["Return date", formatDate(docRow.reviewedAt || docRow.requestedAt || docRow.createdAt)],
    ["Source", String(docRow.source || "—").replace(/_/g, " ")],
    ["Party", partyName],
    ["Status", st || "—"],
    ["Reason", docRow.returnReason || "—"],
  ]);

  const lineRows = [];
  if ((docRow.appliedBatches || []).length) {
    for (const b of docRow.appliedBatches) {
      lineRows.push([
        b.productName || "Product",
        b.batchNumber || "—",
        String(b.quantity ?? 0),
        "—",
      ]);
    }
  } else if ((docRow.lineReturns || []).length) {
    for (const l of docRow.lineReturns) {
      const batches = (l.batchReturns || [])
        .map((br) => br.batchNumber || "")
        .filter(Boolean)
        .join(", ");
      lineRows.push([l.productName || "Product", batches || "—", String(l.returnQuantity ?? 0), "—"]);
    }
  } else if ((docRow.affectedOrders || []).length) {
    for (const o of docRow.affectedOrders) {
      lineRows.push([
        o.orderNumber || "Order",
        o.customerName || "—",
        String(o.returnQuantity ?? 0),
        `₹${money(o.creditAmount)}`,
      ]);
    }
  }
  if (!lineRows.length) {
    lineRows.push(["Return lines", "—", "—", `₹${money(docRow.creditAmount)}`]);
  }

  pdf.fillColor("#0f172a").font("Helvetica-Bold").fontSize(11).text("Return lines", 40, y);
  y += 16;
  y = drawTable(
    pdf,
    y,
    [
      { label: "Item / Order", width: 200 },
      { label: "Batch / Party", width: 160 },
      { label: "Qty", width: 70, align: "right" },
      { label: "Amount", width: 85, align: "right" },
    ],
    lineRows,
    { accent }
  );

  if ((docRow.affectedOrders || []).length > 1) {
    pdf.fillColor("#0f172a").font("Helvetica-Bold").fontSize(10).text("Affected orders", 40, y);
    y += 14;
    for (const o of docRow.affectedOrders) {
      pdf
        .fillColor("#475569")
        .font("Helvetica")
        .fontSize(8)
        .text(
          `${o.orderNumber || "—"} · ${o.customerName || "—"} · qty ${o.returnQuantity || 0} · ₹${money(
            o.creditAmount
          )}`,
          40,
          y,
          { width: pdf.page.width - 80 }
        );
      y += 12;
    }
    y += 8;
  }

  y = drawTotals(
    pdf,
    y,
    [
      ["Credit amount", `₹ ${money(docRow.creditAmount)}`, true],
      ["Prepared by", docRow.requestedBy?.name || docRow.dealer?.name || "—", false],
    ],
    accent
  );

  drawFooter(pdf, "Sale return credit note · stock restored where applicable");
  pdf.end();
  const buffer = await done;
  return {
    ok: true,
    buffer,
    filename: `${invoiceNumber}.pdf`,
    invoiceNumber,
  };
}

/**
 * Purchase return note PDF (supplier).
 */
export async function buildPurchaseReturnInvoicePdf(returnId) {
  const docRow = await PurchaseReturn.findById(returnId)
    .populate("supplier", "name phoneNumber contactPerson")
    .populate("createdBy", "name")
    .populate("purchaseOrder", "poNumber")
    .lean();
  if (!docRow) {
    return { ok: false, error: "Purchase return not found", status: 404 };
  }

  let invoiceNumber = docRow.invoiceNumber;
  if (!invoiceNumber) {
    invoiceNumber = await nextInvoiceNumber(PurchaseReturn, "invoiceNumber", "PRI");
    await PurchaseReturn.updateOne(
      { _id: docRow._id },
      { $set: { invoiceNumber, invoiceGeneratedAt: new Date() } }
    );
  }

  const accent = "#1565c0";
  const pdf = new PDFDocument({
    size: "A4",
    margin: 40,
    info: { Title: `Purchase Return ${invoiceNumber}` },
  });
  const done = bufferFromDoc(pdf);

  drawHeader(pdf, {
    title: "PURCHASE RETURN INVOICE",
    subtitle: "Ram Biotech · Supplier return note",
    accent,
  });

  pdf
    .fillColor(accent)
    .font("Helvetica-Bold")
    .fontSize(11)
    .text(invoiceNumber, 40, 86, { align: "right", width: pdf.page.width - 80 });

  let y = 110;
  const affected = docRow.affectedPurchaseOrders || [];
  const poLabel =
    affected.length > 1
      ? affected.map((p) => p.poNumber).filter(Boolean).join(", ")
      : docRow.poNumber || docRow.purchaseOrder?.poNumber || "—";

  y = drawMetaBox(pdf, y, [
    ["Invoice #", invoiceNumber],
    ["Return #", docRow.returnNumber || "—"],
    ["Date", formatDate(docRow.returnedAt || docRow.createdAt)],
    ["Supplier", docRow.supplier?.name || "—"],
    ["PO(s)", poLabel],
    ["Source", String(docRow.source || "PO_WISE").replace(/_/g, " ")],
    ["Reason", docRow.returnReason || "—"],
  ]);

  const lineRows = (docRow.lines || []).map((l) => [
    l.productName || "Product",
    `${l.batchNumber || "—"}${l.poNumber ? ` · ${l.poNumber}` : ""}`,
    String(l.returnQuantity ?? 0),
    `₹${money(l.amount)}`,
  ]);
  if (!lineRows.length) {
    lineRows.push(["—", "—", String(docRow.totalQuantity || 0), `₹${money(docRow.totalAmount)}`]);
  }

  pdf.fillColor("#0f172a").font("Helvetica-Bold").fontSize(11).text("Returned batches", 40, y);
  y += 16;
  y = drawTable(
    pdf,
    y,
    [
      { label: "Product", width: 180 },
      { label: "Batch / PO", width: 180 },
      { label: "Qty", width: 70, align: "right" },
      { label: "Amount", width: 85, align: "right" },
    ],
    lineRows,
    { accent }
  );

  y = drawTotals(
    pdf,
    y,
    [
      ["Total qty", String(docRow.totalQuantity || 0), false],
      ["Total amount", `₹ ${money(docRow.totalAmount)}`, true],
      ["Created by", docRow.createdBy?.name || "—", false],
    ],
    accent
  );

  drawFooter(pdf, "Purchase return invoice · inventory stock reduced");
  pdf.end();
  const buffer = await done;
  return {
    ok: true,
    buffer,
    filename: `${invoiceNumber}.pdf`,
    invoiceNumber,
  };
}

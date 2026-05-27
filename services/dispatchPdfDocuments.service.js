import PDFDocument from "pdfkit";

/**
 * DC / invoice label: official number, then manual DC field, then dispatchHistory leg for this dispatch.
 * @param {object} order
 * @param {import("mongoose").Types.ObjectId | string} dispatchMongoId
 */
export function resolveChallanInvoiceLabelForPdf(order, dispatchMongoId) {
  const official = String(order?.officialDeliveryChallanNumber || "").trim();
  if (official) return official;
  const manual = String(order?.deliveryChallanInvoiceNumber || "").trim();
  if (manual) return manual;
  const hist = Array.isArray(order?.dispatchHistory) ? order.dispatchHistory : [];
  const entry = hist.find(
    (h) => h?.dispatchId && String(h.dispatchId) === String(dispatchMongoId || "")
  );
  if (entry?.invoiceNumber) return String(entry.invoiceNumber).trim();
  return "";
}

function formatInr(n) {
  const x = Math.round(Number(n) || 0);
  return `Rs.${x.toLocaleString("en-IN")}`;
}

function plantLine(order) {
  const raw = order?.plantName?.name || "—";
  const sid = order?.plantSubtype;
  if (sid && Array.isArray(order?.plantName?.subtypes)) {
    const sub = order.plantName.subtypes.find((s) => String(s._id) === String(sid));
    if (sub?.name) return `${raw} / ${sub.name}`;
  }
  return raw;
}

function getDispatchedQty(order, orderDispatchDetails) {
  const rows = Array.isArray(orderDispatchDetails) ? orderDispatchDetails : [];
  const row = rows.find((d) => String(d.orderId) === String(order._id));
  if (row && row.dispatchQuantity != null) return Number(row.dispatchQuantity) || 0;
  return Number(order?.numberOfPlants || 0) || 0;
}

function getCollectedPayments(order) {
  const rows = Array.isArray(order?.payment) ? order.payment : [];
  return rows.filter((p) => p?.paymentStatus === "COLLECTED");
}

function resolveOrderFreightCharges(order) {
  return Math.max(0, Number(order?.freightCharges ?? 0) || 0);
}

function ensureSpace(doc, yNeeded, bottomMargin = 50) {
  const pageBottom = doc.page.height - bottomMargin;
  if (doc.y + yNeeded > pageBottom) doc.addPage();
}

/**
 * @param {object} dispatch — lean Dispatch with populated `orderIds`, `orderDispatchDetails`
 */
export function buildDeliveryChallanPdfBuffer(dispatch) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const doc = new PDFDocument({
      size: "A4",
      margin: 40,
      info: { Title: "Delivery Challan" },
    });
    doc.on("data", (c) => chunks.push(c));
    doc.on("error", reject);
    doc.on("end", () => resolve(Buffer.concat(chunks)));

    const dispatchMongoId = dispatch._id;
    const orders = Array.isArray(dispatch.orderIds) ? dispatch.orderIds : [];
    const created = dispatch.createdAt ? new Date(dispatch.createdAt) : new Date();

    doc.fontSize(16).text("Delivery Challan", { underline: true });
    doc.moveDown(0.6);
    doc.fontSize(10);
    doc.text(`Transport ID: ${dispatch.transportId ?? "—"}`);
    doc.text(`Driver: ${dispatch.driverName || "—"}    Vehicle: ${dispatch.vehicleName || "—"}`);
    if (dispatch.vehicleNumber) doc.text(`Vehicle number: ${dispatch.vehicleNumber}`);
    if (dispatch.routeNotes) doc.text(`Route notes: ${dispatch.routeNotes}`);
    if (dispatch.driverRemark) doc.text(`Driver instructions: ${dispatch.driverRemark}`);
    if (dispatch.vehicleRemark) doc.text(`Vehicle / load notes: ${dispatch.vehicleRemark}`);
    doc.text(`Date: ${created.toLocaleDateString("en-IN")}`);
    doc.moveDown(1);

    if (!orders.length) {
      doc.fontSize(11).text("No orders on this dispatch.");
      doc.end();
      return;
    }

    doc.fontSize(9);
    const rowGap = 4;
    orders.forEach((order, idx) => {
      ensureSpace(doc, 72);
      const farmer = order?.farmer;
      const qty = getDispatchedQty(order, dispatch.orderDispatchDetails);
      const rate = Number(order?.rate || 0);
      const freight = resolveOrderFreightCharges(order);
      const plantAmount = qty * rate;
      const lineTotal = plantAmount + freight;
      const dcLabel = resolveChallanInvoiceLabelForPdf(order, dispatchMongoId);
      const orderNum = order?.orderId != null ? String(order.orderId) : "";

      doc.font("Helvetica-Bold").text(`Order ${idx + 1}${orderNum ? ` (#${orderNum})` : ""}`);
      doc.font("Helvetica");
      doc.text(`Farmer: ${farmer?.name || "—"}    Mobile: ${farmer?.mobileNumber || "—"}`);
      doc.text(`Village: ${farmer?.village || "—"}`);
      doc.text(`Plant: ${plantLine(order)}`);
      doc.text(`Dispatched qty: ${qty}    Rate: ${formatInr(rate)} / plant`);
      doc.text(`DC / Invoice ref: ${dcLabel || "—"}`);
      const manualStr = String(order?.deliveryChallanInvoiceNumber || "").trim();
      if (manualStr && manualStr !== dcLabel) {
        doc.text(`Manual DC / sticker: ${manualStr}`);
      }
      doc.text(`Plant amount: ${formatInr(plantAmount)}`);
      if (freight > 0) doc.text(`Freight: ${formatInr(freight)}`);
      doc.text(`Line total: ${formatInr(lineTotal)}`);
      doc.moveDown(rowGap);
      if (idx < orders.length - 1) doc.moveTo(40, doc.y).lineTo(doc.page.width - 40, doc.y).strokeColor("#cccccc").stroke();
      doc.moveDown(rowGap);
    });

    doc.moveDown(0.5);
    const totalQty = orders.reduce(
      (s, o) => s + getDispatchedQty(o, dispatch.orderDispatchDetails),
      0
    );
    doc.font("Helvetica-Bold").text(`Total plants (dispatched lines): ${totalQty}`);

    doc.end();
  });
}

/**
 * Complete invoice — functional parity with web (per order: gross, returns, damage, collected, net due).
 * @param {object} dispatch — lean; `transportStatus` should be DELIVERED (enforced by route).
 */
export function buildCompleteInvoicePdfBuffer(dispatch) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const doc = new PDFDocument({
      size: "A4",
      margin: 40,
      info: { Title: "Complete Invoice" },
    });
    doc.on("data", (c) => chunks.push(c));
    doc.on("error", reject);
    doc.on("end", () => resolve(Buffer.concat(chunks)));

    const dispatchMongoId = dispatch._id;
    const orders = Array.isArray(dispatch.orderIds) ? dispatch.orderIds : [];
    const today = new Date().toLocaleDateString("en-IN");

    doc.fontSize(16).text("Complete Invoice", { underline: true });
    doc.fontSize(9).text(`Transport: ${dispatch.transportId ?? "—"}    ${today}`, { align: "right" });
    doc.moveDown(1);

    if (!orders.length) {
      doc.fontSize(11).text("No orders on this dispatch.");
      doc.end();
      return;
    }

    orders.forEach((order, idx) => {
      if (idx > 0) doc.addPage();

      const dispatchedQty = getDispatchedQty(order, dispatch.orderDispatchDetails);
      const rate = Number(order?.rate || 0);
      const freight = resolveOrderFreightCharges(order);
      const plantAmount = dispatchedQty * rate;
      const gross = plantAmount + freight;
      const returned = Number(order?.returnedPlants ?? 0);
      const damaged = Number(order?.damagedPlants ?? 0);
      const returnedAmount = returned * rate;
      const damagedAmount = damaged * rate;
      const collected = getCollectedPayments(order);
      const totalPaid = collected.reduce((sum, p) => sum + Number(p?.paidAmount || 0), 0);
      const netDue = Math.max(0, gross - returnedAmount - damagedAmount - totalPaid);
      const dcNo = resolveChallanInvoiceLabelForPdf(order, dispatchMongoId);
      const farmer = order?.farmer;
      const orderNum = order?.orderId != null ? String(order.orderId) : "";

      doc.fontSize(12).font("Helvetica-Bold").text(`Order ${orderNum || "—"}`);
      doc.font("Helvetica").fontSize(10);
      doc.text(`DC ref: ${dcNo || "—"}`);
      const manualInv = String(order?.deliveryChallanInvoiceNumber || "").trim();
      if (manualInv && manualInv !== dcNo) {
        doc.text(`Manual DC / sticker: ${manualInv}`);
      }
      doc.moveDown(0.5);
      doc.text(`Farmer: ${farmer?.name || "—"}    Mobile: ${farmer?.mobileNumber || "—"}`);
      doc.text(`Village: ${farmer?.village || "—"}`);
      doc.text(`Plant: ${plantLine(order)}`);
      doc.moveDown(0.8);

      doc.fontSize(10).font("Helvetica-Bold").text("Amounts");
      doc.font("Helvetica").fontSize(9);
      doc.text(`Dispatched plants: ${dispatchedQty}`);
      doc.text(`Rate: ${formatInr(rate)} / plant`);
      doc.text(`Plant amount: ${formatInr(plantAmount)}`);
      if (freight > 0) doc.text(`Freight: ${formatInr(freight)}`);
      doc.text(`Gross: ${formatInr(gross)}`);
      doc.text(`Returned: ${returned} plants  (${formatInr(-returnedAmount)})`);
      doc.text(`Damaged: ${damaged} plants  (${formatInr(-damagedAmount)})`);
      doc.text(`Collected (COLLECTED payments): ${formatInr(totalPaid)}`);
      doc.moveDown(0.3);
      doc.font("Helvetica-Bold").text(`Net due: ${formatInr(netDue)}`);
    });

    // Vehicle Trip Summary — appended when trip details were recorded at completion
    const trip = dispatch.tripId;
    if (
      trip &&
      (trip.kmRun != null || trip.rent != null || trip.otherCharges != null || trip.tripRemark)
    ) {
      doc.addPage();
      doc.fontSize(14).font("Helvetica-Bold").text("Vehicle Trip Summary");
      doc.font("Helvetica").fontSize(10).moveDown(0.6);
      doc.text(`Transport: ${dispatch.transportId ?? "—"}    Driver: ${dispatch.driverName || "—"}    Vehicle: ${dispatch.vehicleName || "—"}`);
      if (dispatch.vehicleNumber) doc.text(`Vehicle No: ${dispatch.vehicleNumber}`);
      doc.moveDown(0.5);
      if (trip.kmRun != null) doc.text(`KM Run: ${trip.kmRun} km`);
      if (trip.rent != null) doc.text(`Rent: ${formatInr(trip.rent)}`);
      if (trip.otherCharges != null) doc.text(`Other Charges: ${formatInr(trip.otherCharges)}`);
      if (trip.tripRemark) doc.text(`Remark: ${trip.tripRemark}`);
    }

    doc.end();
  });
}

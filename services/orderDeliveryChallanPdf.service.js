import Order from "../models/order.model.js";
import { uploadToS3 } from "./uploadService.js";
import { buildDeliveryChallanPdfBuffer } from "./dispatchPdfDocuments.service.js";
import { assertLinkedAgriLoadForDc } from "./linkedAgriLoadGuard.service.js";
import { ensureOrderDcNumbersIfEligible } from "./ensureOrderDcForChallan.service.js";

/**
 * Load order lean with populates needed for DC HTML.
 */
async function loadOrderLeanForDcPdf(orderId) {
  return Order.findById(orderId)
    .populate({
      path: "farmer",
      select:
        "name mobileNumber village talukaName districtName stateName state taluka district aadharNumber aadhaarNumber",
    })
    .populate({ path: "salesPerson", select: "name phoneNumber" })
    .populate({ path: "plantName", select: "name variety type subtypes" })
    .populate({ path: "cavity", select: "name cavity numberPerCrate" })
    .populate({ path: "bookingSlot", select: "startDay endDay month" })
    .lean();
}

function syntheticDispatchForOrder(order) {
  return {
    _id: null,
    transportId: "INSTANT",
    driverName: "—",
    vehicleName: "—",
    orderIds: [order],
    orderDispatchDetails: [
      {
        orderId: order._id,
        dispatchQuantity: Number(order.numberOfPlants || order.totalPlants || 0),
      },
    ],
    plantsDetails: [],
  };
}

/**
 * Generate (or regenerate) per-order delivery challan PDF.
 * On regenerate, archives previous current URL into deliveryChallanPdfHistory.
 * @returns {{ deliveryChallanPdfUrl, deliveryChallanPdfGeneratedAt, deliveryChallanPdfHistory }}
 */
export async function generateAndSaveOrderDeliveryChallanPdf(orderId, options = {}) {
  const force = Boolean(options.force);
  const generatedBy = options.generatedBy || null;

  const order = await loadOrderLeanForDcPdf(orderId);
  if (!order) {
    const err = new Error("Order not found");
    err.statusCode = 404;
    throw err;
  }

  await assertLinkedAgriLoadForDc(orderId);

  const ensured = await ensureOrderDcNumbersIfEligible(order, null);
  if (Object.keys(ensured.setFields || {}).length) {
    await Order.findByIdAndUpdate(order._id, { $set: ensured.setFields });
    Object.assign(order, ensured.setFields);
  }

  const hasDc =
    String(order.officialDeliveryChallanNumber || "").trim() ||
    String(order.officialNonBillableDeliveryChallanNumber || "").trim() ||
    String(order.deliveryChallanInvoiceNumber || "").trim();
  if (!hasDc) {
    const err = new Error("Order has no delivery challan number yet");
    err.statusCode = 400;
    throw err;
  }

  const existingUrl = String(order.deliveryChallanPdfUrl || "").trim();
  if (existingUrl && !force) {
    return {
      deliveryChallanPdfUrl: existingUrl,
      deliveryChallanPdfGeneratedAt: order.deliveryChallanPdfGeneratedAt || null,
      deliveryChallanPdfHistory: Array.isArray(order.deliveryChallanPdfHistory)
        ? order.deliveryChallanPdfHistory
        : [],
    };
  }

  const fakeDispatch = syntheticDispatchForOrder(order);
  const buf = await buildDeliveryChallanPdfBuffer(fakeDispatch);
  const oid = String(order._id);
  const stamp = Date.now();
  const url = await uploadToS3(buf, `order-delivery-challan-${oid}-${stamp}.pdf`, {
    folder: `order-pdfs/${oid}`,
  });
  const now = new Date();

  const update = {
    $set: {
      deliveryChallanPdfUrl: url,
      deliveryChallanPdfGeneratedAt: now,
    },
  };

  if (existingUrl) {
    update.$push = {
      deliveryChallanPdfHistory: {
        url: existingUrl,
        generatedAt: order.deliveryChallanPdfGeneratedAt || null,
        replacedAt: now,
        generatedBy: generatedBy || undefined,
      },
    };
  }

  const updated = await Order.findByIdAndUpdate(order._id, update, { new: true })
    .select("deliveryChallanPdfUrl deliveryChallanPdfGeneratedAt deliveryChallanPdfHistory")
    .lean();

  return {
    deliveryChallanPdfUrl: updated?.deliveryChallanPdfUrl || url,
    deliveryChallanPdfGeneratedAt: updated?.deliveryChallanPdfGeneratedAt || now,
    deliveryChallanPdfHistory: Array.isArray(updated?.deliveryChallanPdfHistory)
      ? updated.deliveryChallanPdfHistory
      : [],
  };
}

export function scheduleOrderDeliveryChallanPdf(orderId) {
  if (!orderId) return;
  setImmediate(() => {
    (async () => {
      try {
        await generateAndSaveOrderDeliveryChallanPdf(orderId, { force: false });
        const { ensureOrderDispatchWhatsAppOnce } = await import(
          "./orderDispatchWhatsApp.service.js"
        );
        await ensureOrderDispatchWhatsAppOnce(orderId, { allowManualResend: false });
      } catch (err) {
        console.error(
          `[scheduleOrderDeliveryChallanPdf] order=${orderId}:`,
          err?.message || err
        );
      }
    })();
  });
}

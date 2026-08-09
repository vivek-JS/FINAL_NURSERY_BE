import AgriSalesOrder from "../models/agriSalesOrder.model.js";
import { uploadToS3 } from "./uploadService.js";
import { htmlToPdfBuffer } from "./htmlToPdf.service.js";
import { mapAgriOrderToChallanPage } from "../../shared/dispatch-documents/agriDispatchDocumentMappers.js";
import { renderAgriDeliveryChallanDocument } from "../../shared/dispatch-documents/agriDeliveryChallanTemplate.js";

async function nextAgriDcNumber(order) {
  if (order?.dcNumber) return order.dcNumber;
  const yn = new Date().getFullYear().toString().slice(-2);
  const seq = String(order?.orderNumber || order?._id || Date.now())
    .replace(/\D/g, "")
    .slice(-5)
    .padStart(5, "0");
  return `AGRI-DC${yn}${seq}`;
}

/**
 * Generate A5 delivery challan PDF for a Ram Agri sales order and persist URL.
 * Safe to call after dispatch; returns null-ish fields on soft failure when swallow=true.
 */
export async function generateAndSaveAgriDeliveryChallanPdf(orderId, options = {}) {
  const force = Boolean(options.force);
  const swallow = options.swallow !== false;

  try {
    const order = await AgriSalesOrder.findById(orderId)
      .populate("productId", "name code")
      .populate("ramAgriCropId", "cropName")
      .populate("lineItems.productId", "name code")
      .populate("lineItems.ramAgriCropId", "cropName")
      .lean();

    if (!order) {
      const err = new Error("Agri sales order not found");
      err.statusCode = 404;
      throw err;
    }

    const existingUrl = String(order.deliveryChallanPdfUrl || "").trim();
    if (existingUrl && !force) {
      return {
        deliveryChallanPdfUrl: existingUrl,
        dcNumber: order.dcNumber || null,
        dcGeneratedAt: order.dcGeneratedAt || null,
      };
    }

    const dcNumber = await nextAgriDcNumber(order);
    const page = mapAgriOrderToChallanPage(order, {
      dcNumber,
      generatedAt: new Date(),
    });
    const html = renderAgriDeliveryChallanDocument([page], `DC ${dcNumber}`);
    const buf = await htmlToPdfBuffer(html, { width: "148mm", height: "210mm" });
    const oid = String(order._id);
    const url = await uploadToS3(buf, `agri-delivery-challan-${oid}-${Date.now()}.pdf`, {
      folder: `agri-order-pdfs/${oid}`,
    });
    const now = new Date();

    await AgriSalesOrder.findByIdAndUpdate(order._id, {
      $set: {
        deliveryChallanPdfUrl: url,
        dcNumber,
        dcGeneratedAt: now,
      },
    });

    return { deliveryChallanPdfUrl: url, dcNumber, dcGeneratedAt: now };
  } catch (err) {
    console.error("[agriDeliveryChallanPdf]", orderId, err?.message || err);
    if (swallow) {
      return {
        deliveryChallanPdfUrl: null,
        dcNumber: null,
        dcGeneratedAt: null,
        error: err?.message || String(err),
      };
    }
    throw err;
  }
}

/** Fire-and-forget helpers after dispatch — does not throw. */
export function scheduleAgriDeliveryChallanPdfs(orderIds = []) {
  for (const id of orderIds) {
    if (!id) continue;
    setImmediate(() => {
      generateAndSaveAgriDeliveryChallanPdf(id, { swallow: true }).catch(() => {});
    });
  }
}

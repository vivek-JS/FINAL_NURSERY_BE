import Dispatch from "../models/dispatch.model.js";
import { uploadToS3 } from "./uploadService.js";
import {
  buildDeliveryChallanPdfBuffer,
  buildCompleteInvoicePdfBuffer,
} from "./dispatchPdfDocuments.service.js";

/**
 * Load dispatch lean document for PDF generation (mirrors controller helper).
 */
async function loadDispatchLeanForPdfGeneration(dispatchObjectId) {
  const Tray = (await import("../models/tray.model.js")).default;

  const dispatch = await Dispatch.findById(dispatchObjectId)
    .populate({ path: "tripId" })
    .populate({
      path: "orderIds",
      populate: [
        { path: "farmer", select: "name mobileNumber village talukaName districtName stateName state taluka district" },
        { path: "salesPerson", select: "name phoneNumber" },
        { path: "plantName", select: "name variety type subtypes" },
        { path: "cavity", select: "name cavity numberPerCrate" },
        { path: "bookingSlot", select: "startDay endDay month" },
      ],
    })
    .lean();

  if (!dispatch) return null;

  const trayIds = [];
  (dispatch.plantsDetails || []).forEach((plant) => {
    if (Array.isArray(plant.pickupDetails)) {
      plant.pickupDetails.forEach((pickup) => {
        if (pickup.cavity) trayIds.push(pickup.cavity);
      });
    }
    if (Array.isArray(plant.crates)) {
      plant.crates.forEach((crate) => {
        if (crate.cavity) trayIds.push(crate.cavity);
      });
    }
  });
  const uniqueTrayIds = [...new Set(trayIds.map((id) => id.toString()))];
  if (uniqueTrayIds.length) {
    await Tray.find({ _id: { $in: uniqueTrayIds } }).lean();
  }

  return dispatch;
}

/**
 * Generate and persist dispatch PDF URLs (non-blocking helper).
 * Archives previous current URLs into history arrays on regenerate.
 * @param {string|import('mongoose').Types.ObjectId} dispatchId
 * @param {Array<'delivery_challan'|'complete_invoice'>} types
 * @param {{ force?: boolean }} [options]
 */
export async function generateAndSaveDispatchPdfs(dispatchId, types = ["delivery_challan"], options = {}) {
  const loaded = await loadDispatchLeanForPdfGeneration(dispatchId);
  if (!loaded) return null;

  const force = Boolean(options.force);
  const dispatchObjectId = String(loaded._id);
  const now = new Date();
  const $set = {};
  const $push = {};

  if (types.includes("delivery_challan")) {
    const prevUrl = String(loaded.deliveryChallanPdfUrl || "").trim();
    if (prevUrl && !force) {
      // reuse
    } else {
      const buf = await buildDeliveryChallanPdfBuffer(loaded);
      const url = await uploadToS3(buf, `delivery-challan-${dispatchObjectId}-${Date.now()}.pdf`, {
        folder: `dispatch-pdfs/${dispatchObjectId}`,
      });
      $set.deliveryChallanPdfUrl = url;
      $set.deliveryChallanPdfGeneratedAt = now;
      if (prevUrl) {
        $push.deliveryChallanPdfHistory = {
          url: prevUrl,
          generatedAt: loaded.deliveryChallanPdfGeneratedAt || null,
          replacedAt: now,
        };
      }
    }
  }

  if (types.includes("complete_invoice")) {
    if (String(loaded.transportStatus || "").toUpperCase() === "CANCELLED") {
      throw new Error("Invoice PDF is not available for cancelled dispatches");
    }
    if (String(loaded.transportStatus || "").toUpperCase() !== "DELIVERED") {
      throw new Error("Invoice PDF requires DELIVERED status (complete the order form first)");
    }
    const prevUrl = String(loaded.completeInvoicePdfUrl || "").trim();
    if (prevUrl && !force) {
      // reuse existing invoice PDF
    } else {
      const buf = await buildCompleteInvoicePdfBuffer(loaded);
      const url = await uploadToS3(buf, `complete-invoice-${dispatchObjectId}-${Date.now()}.pdf`, {
        folder: `dispatch-pdfs/${dispatchObjectId}`,
      });
      $set.completeInvoicePdfUrl = url;
      $set.completeInvoicePdfGeneratedAt = now;
      if (prevUrl) {
        $push.completeInvoicePdfHistory = {
          url: prevUrl,
          generatedAt: loaded.completeInvoicePdfGeneratedAt || null,
          replacedAt: now,
        };
      }
    }
  }

  if (!Object.keys($set).length) return null;

  const update = { $set };
  if (Object.keys($push).length) update.$push = $push;

  return Dispatch.findByIdAndUpdate(loaded._id, update, { new: true })
    .select(
      "deliveryChallanPdfUrl deliveryChallanPdfGeneratedAt deliveryChallanPdfHistory completeInvoicePdfUrl completeInvoicePdfGeneratedAt completeInvoicePdfHistory"
    )
    .lean();
}

/** Fire-and-forget PDF generation; logs errors, never throws to caller. */
export function scheduleDispatchPdfGeneration(dispatchId, types = ["delivery_challan"]) {
  if (!dispatchId) return;
  setImmediate(() => {
    generateAndSaveDispatchPdfs(dispatchId, types).catch((err) => {
      console.error(
        `[scheduleDispatchPdfGeneration] dispatch=${dispatchId} types=${types.join(",")}:`,
        err?.message || err
      );
    });
  });
}

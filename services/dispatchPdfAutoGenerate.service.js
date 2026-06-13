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
 * @param {string|import('mongoose').Types.ObjectId} dispatchId
 * @param {Array<'delivery_challan'|'complete_invoice'>} types
 */
export async function generateAndSaveDispatchPdfs(dispatchId, types = ["delivery_challan"]) {
  const loaded = await loadDispatchLeanForPdfGeneration(dispatchId);
  if (!loaded) return null;

  const dispatchObjectId = String(loaded._id);
  const now = new Date();
  const $set = {};

  if (types.includes("delivery_challan")) {
    const buf = await buildDeliveryChallanPdfBuffer(loaded);
    const url = await uploadToS3(buf, `delivery-challan-${dispatchObjectId}.pdf`, {
      folder: `dispatch-pdfs/${dispatchObjectId}`,
    });
    $set.deliveryChallanPdfUrl = url;
    $set.deliveryChallanPdfGeneratedAt = now;
  }

  if (types.includes("complete_invoice")) {
    if (String(loaded.transportStatus || "").toUpperCase() === "CANCELLED") {
      throw new Error("Invoice PDF is not available for cancelled dispatches");
    }
    const buf = await buildCompleteInvoicePdfBuffer(loaded);
    const url = await uploadToS3(buf, `complete-invoice-${dispatchObjectId}.pdf`, {
      folder: `dispatch-pdfs/${dispatchObjectId}`,
    });
    $set.completeInvoicePdfUrl = url;
    $set.completeInvoicePdfGeneratedAt = now;
  }

  if (!Object.keys($set).length) return null;

  return Dispatch.findByIdAndUpdate(loaded._id, { $set }, { new: true })
    .select(
      "deliveryChallanPdfUrl deliveryChallanPdfGeneratedAt completeInvoicePdfUrl completeInvoicePdfGeneratedAt"
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

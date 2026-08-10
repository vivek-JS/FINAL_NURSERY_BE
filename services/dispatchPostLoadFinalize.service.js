import mongoose from "mongoose";
import Order from "../models/order.model.js";
import Dispatch from "../models/dispatch.model.js";
import { updateOrderWithLedgerSync } from "../controllers/dispatch.controller.js";
import { ensureOfficialDcSetFields } from "./officialDeliveryChallan.service.js";
import { scheduleDispatchPdfGeneration } from "./dispatchPdfAutoGenerate.service.js";
import { hasPendingLinkedAgriLoadForOrder } from "./linkedAgriLoadGuard.service.js";

const orderRemainingPlantsValue = (doc) => {
  const rem = doc?.remainingPlants;
  if (rem != null && Number.isFinite(Number(rem))) return Number(rem);
  return Number(doc?.numberOfPlants || 0) + Number(doc?.additionalPlants || 0);
};

/**
 * When shed load completes an order line on a dispatch, set DISPATCHED + official DC(s).
 * Billable subtypes → officialDeliveryChallanNumber (global dc_billable).
 * Non-billable subtypes → officialNonBillableDeliveryChallanNumber (global dc_non_billable).
 * Mixed orders get both numbers; PDF emits two pages.
 * Returns { orderId, dispatchId } for post-commit PDF/WhatsApp hooks.
 */
export async function finalizeOrderOnShedLineLoaded({
  session,
  orderId,
  dispatchDoc,
  orderLoaded,
  performedBy,
}) {
  if (!orderId || !orderLoaded?.fullyLoaded) return null;

  const order = await Order.findById(orderId).session(session);
  if (!order) return null;

  if (order.orderStatus === "DISPATCHED") {
    return { orderId: String(orderId), dispatchId: String(dispatchDoc._id), skipped: true };
  }

  const agriLoadBlocked = await hasPendingLinkedAgriLoadForOrder(orderId, session);
  if (agriLoadBlocked) {
    return {
      orderId: String(orderId),
      dispatchId: String(dispatchDoc._id),
      skipped: true,
      agriLoadBlocked: true,
      becameDispatched: false,
    };
  }

  const remaining = orderRemainingPlantsValue(order);
  const preAssigned = String(order.deliveryChallanInvoiceNumber || "").trim();
  let officialPrimary = null;
  let officialSet = {};
  let invoiceLabel = preAssigned;

  if (remaining <= 0) {
    const ensured = await ensureOfficialDcSetFields(order, session);
    officialSet = ensured.setFields;
    officialPrimary = ensured.primaryLabel;
    if (officialPrimary) {
      invoiceLabel = officialPrimary;
    }
  }

  const dispatchHistoryEntry = {
    date: new Date(),
    quantity: Number(orderLoaded.shedLoadedQuantity) || Number(orderLoaded.dispatchQuantity) || 0,
    dispatchId: dispatchDoc._id,
    remainingAfterDispatch: remaining,
    processedBy:
      performedBy && mongoose.isValidObjectId(String(performedBy)) ? performedBy : undefined,
    driverName: dispatchDoc.driverName || "",
    vehicleName: dispatchDoc.vehicleName || "",
    source: "SECONDARY_SHED_COMPLETE",
    ...(invoiceLabel ? { invoiceNumber: invoiceLabel } : {}),
  };

  const setFields = {
    orderStatus: remaining <= 0 ? "DISPATCHED" : order.orderStatus,
    ...officialSet,
  };

  const updatedOrder = await updateOrderWithLedgerSync({
    orderId,
    existingDoc: order,
    session,
    userId: performedBy,
    contextLabel: "shed_load_finalize_order",
    updateOperation: {
      $set: setFields,
      $push: { dispatchHistory: dispatchHistoryEntry },
    },
  });

  return {
    orderId: String(orderId),
    dispatchId: String(dispatchDoc._id),
    order: updatedOrder?.toObject ? updatedOrder.toObject() : updatedOrder,
    becameDispatched: setFields.orderStatus === "DISPATCHED",
  };
}

/**
 * When agri load was pending at shed complete, finalize DC once all linked agri rows are LOADED.
 */
export async function retryNurseryOrderDcAfterAgriLoaded(nurseryOrderId, { changedBy = "System" } = {}) {
  const orderId = String(nurseryOrderId || "").trim();
  if (!mongoose.isValidObjectId(orderId)) return null;

  const order = await Order.findById(orderId).lean();
  if (!order || String(order.orderStatus || "").toUpperCase() === "DISPATCHED") {
    return null;
  }
  if (await hasPendingLinkedAgriLoadForOrder(orderId)) {
    return null;
  }

  const dispatchId = order.currentDispatchId;
  if (!dispatchId) return null;

  const dispatchDoc = await Dispatch.findById(dispatchId);
  if (!dispatchDoc) return null;

  const row = (dispatchDoc.orderDispatchDetails || []).find(
    (d) => String(d.orderId) === orderId
  );
  if (!row) return null;

  const dispatchQty = Math.max(0, Number(row.dispatchQuantity) || 0);
  const shedLoaded = Math.max(0, Number(row.shedLoadedQuantity) || 0);
  if (!(dispatchQty > 0 && shedLoaded >= dispatchQty)) {
    return null;
  }

  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const orderLoaded = {
      fullyLoaded: true,
      shedLoadedQuantity: shedLoaded,
      dispatchQuantity: dispatchQty,
    };
    const finalizeResult = await finalizeOrderOnShedLineLoaded({
      session,
      orderId,
      dispatchDoc,
      orderLoaded,
      performedBy: null,
    });
    await session.commitTransaction();
    schedulePostShedLoadAlerts({ finalizeResult, changedBy });
    return finalizeResult;
  } catch (err) {
    await session.abortTransaction();
    console.error("retryNurseryOrderDcAfterAgriLoaded:", err?.message || err);
    return null;
  } finally {
    session.endSession();
  }
}

/** Fire-and-forget PDF + WhatsApp after shed load transaction commits. */
export function schedulePostShedLoadAlerts({ finalizeResult, changedBy = "Unknown" }) {
  if (!finalizeResult?.becameDispatched || finalizeResult.skipped || finalizeResult.agriLoadBlocked) {
    return;
  }

  const { orderId, dispatchId, order } = finalizeResult;

  (async () => {
    try {
      scheduleDispatchPdfGeneration(dispatchId, ["delivery_challan"]);
      const { scheduleOrderDeliveryChallanPdf } = await import(
        "./orderDeliveryChallanPdf.service.js"
      );
      scheduleOrderDeliveryChallanPdf(orderId);
    } catch (e) {
      console.error("post-shed-load PDF schedule:", e?.message || e);
    }
  })();

  (async () => {
    try {
      const { sendOrderDispatchedAlert } = await import("./whatsappAlertService.js");
      const plain = order || (await Order.findById(orderId).lean());
      if (plain) await sendOrderDispatchedAlert(plain, changedBy);
    } catch (e) {
      console.error("post-shed-load WhatsApp:", e?.message || e);
    }
  })();

  (async () => {
    try {
      const { notifyPlantOrderDispatched } = await import("../utility/mobileOrderPushNotify.js");
      const plain = order || (await Order.findById(orderId).lean());
      if (plain) notifyPlantOrderDispatched(plain);
    } catch (e) {
      console.error("post-shed-load push:", e?.message || e);
    }
  })();

  (async () => {
    try {
      const { ensureFeedbackCallForOrder } = await import("./feedbackCallScheduling.js");
      const o = order || (await Order.findById(orderId).lean());
      if (o?.orderStatus === "DISPATCHED") {
        await ensureFeedbackCallForOrder(o, { isInstantDispatch: false });
      }
    } catch (e) {
      console.error("post-shed-load voice feedback:", e?.message || e);
    }
  })();
}

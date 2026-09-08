import moment from "moment";
import mongoose from "mongoose";
import Dispatch from "../models/dispatch.model.js";
import Order from "../models/order.model.js";
import {
  buildWatiSendRecipient,
  sendWatiTemplateMessage,
} from "../utility/watiMessaging.js";
import { formatWatiDateDdMmYyyy } from "../utility/watiIstDateFormat.js";
import {
  watiPlantAndSubtypeParams,
  resolveEmbeddedSubtypeName,
} from "../utility/watiPlantText.js";

export const AFTER_DELIVERY_TEMPLATE =
  process.env.WATI_AFTER_DELIVERY_TEMPLATE || "after_delivery";

const ist = () => moment().utcOffset(330);

/**
 * Build WATI params for after_delivery:
 * {{1}} name, {{2}} delivery date, {{3}} plant, {{4}} subtype
 */
export function buildAfterDeliveryParameters(farmer, order, deliveryDate) {
  const plantDoc = order?.plantName;
  const plantName =
    typeof plantDoc === "object" && plantDoc?.name
      ? plantDoc.name
      : String(order?.productName || "Plants");
  const subtypeName =
    resolveEmbeddedSubtypeName(plantDoc, order?.plantSubtype) ||
    String(order?.subtypeName || "");

  const { plantParam, subtypeParam } = watiPlantAndSubtypeParams(
    plantName,
    subtypeName
  );

  const dateLabel =
    formatWatiDateDdMmYyyy(deliveryDate || order?.deliveryDate || new Date()) ||
    ist().format("D-MMMM-YYYY");

  return [
    { name: "1", value: farmer?.name || "Farmer" },
    { name: "2", value: dateLabel },
    { name: "3", value: plantParam },
    { name: "4", value: subtypeParam === "—" ? "" : subtypeParam || "" },
  ];
}

export function previewAfterDeliveryMessage(farmer, order, deliveryDate) {
  const params = buildAfterDeliveryParameters(farmer, order, deliveryDate);
  const p = Object.fromEntries(params.map((x) => [x.name, x.value]));
  return `नमस्कार ${p["1"]} जी 🙏
आपल्याला दिनांक ${p["2"]} रोजी ${p["3"]} - ${p["4"]} ची रोपे व्यवस्थित मिळाली का?
(Order ${order?.orderId || order?._id})`;
}

/**
 * Send after_delivery to one farmer for one order line on a completed dispatch.
 */
export async function sendAfterDeliveryWhatsAppForOrder(order, dispatchMeta = {}) {
  const farmer = order?.farmer;
  const sendTo = buildWatiSendRecipient(farmer);
  if (!sendTo?.mobileNumber) {
    return {
      success: false,
      skipped: true,
      reason: "no_mobile",
      orderId: String(order?._id || ""),
    };
  }

  const deliveryDate =
    dispatchMeta.deliveryCompletedAt || dispatchMeta.updatedAt || new Date();
  const parameters = buildAfterDeliveryParameters(sendTo, order, deliveryDate);

  const result = await sendWatiTemplateMessage(
    sendTo.mobileNumber,
    AFTER_DELIVERY_TEMPLATE,
    parameters
  );

  return {
    success: !!result?.success,
    orderId: String(order._id),
    orderNumber: order.orderId || String(order._id),
    farmerName: sendTo.name || farmer?.name,
    phone: sendTo.mobileNumber,
    parameters,
    preview: previewAfterDeliveryMessage(sendTo, order, deliveryDate),
    error: result?.error || null,
    watiResponse: result?.data || null,
  };
}

/**
 * All orders on a vehicle dispatch after complete-delivery form (transport DELIVERED).
 */
export async function sendAfterDeliveryForDispatch(
  dispatchId,
  { dryRun = false, allowPending = false } = {}
) {
  if (!dispatchId || !mongoose.isValidObjectId(String(dispatchId))) {
    throw new Error("Valid dispatchId is required");
  }

  const dispatch = await Dispatch.findById(dispatchId).lean();
  if (!dispatch) throw new Error("Dispatch not found");
  const status = String(dispatch.transportStatus || "").toUpperCase();
  if (status === "CANCELLED") {
    return {
      dispatchId: String(dispatchId),
      skipped: true,
      reason: "cancelled",
      messages: [],
    };
  }
  if (!dryRun && !allowPending && status !== "DELIVERED") {
    return {
      dispatchId: String(dispatchId),
      skipped: true,
      reason: "not_delivered",
      transportStatus: status,
      messages: [],
    };
  }

  const orderIds = (dispatch.orderIds || []).map(String).filter(Boolean);
  if (!orderIds.length) {
    return { dispatchId: String(dispatchId), messages: [], count: 0 };
  }

  const orders = await Order.find({ _id: { $in: orderIds } })
    .populate("farmer", "name mobileNumber phoneNumber village")
    .populate("plantName", "name subtypes")
    .lean();

  const dispatchMeta = {
    deliveryCompletedAt: dispatch.updatedAt,
    vehicleNumber: dispatch.vehicleNumber,
    driverName: dispatch.driverName,
  };

  const messages = [];
  for (const order of orders) {
    if (dryRun) {
      const farmer = order.farmer;
      const sendTo = buildWatiSendRecipient(farmer);
      messages.push({
        success: true,
        dryRun: true,
        dispatchId: String(dispatchId),
        orderId: String(order._id),
        orderNumber: order.orderId || String(order._id),
        farmerName: sendTo?.name || farmer?.name || "—",
        phone: sendTo?.mobileNumber || null,
        vehicleNumber: dispatch.vehicleNumber,
        parameters: buildAfterDeliveryParameters(
          sendTo || farmer,
          order,
          dispatchMeta.deliveryCompletedAt
        ),
        preview: previewAfterDeliveryMessage(
          sendTo || farmer,
          order,
          dispatchMeta.deliveryCompletedAt
        ),
        skipped: !sendTo?.mobileNumber,
        skipReason: !sendTo?.mobileNumber ? "no_mobile" : null,
      });
      continue;
    }

    messages.push(await sendAfterDeliveryWhatsAppForOrder(order, dispatchMeta));
  }

  return {
    dispatchId: String(dispatchId),
    transportId: dispatch.transportId,
    vehicleNumber: dispatch.vehicleNumber,
    driverName: dispatch.driverName,
    transportStatus: status,
    deliveryCompletedAt: dispatch.updatedAt,
    dryRun,
    count: messages.length,
    sent: messages.filter((m) => m.success && !m.skipped).length,
    skipped: messages.filter((m) => m.skipped).length,
    failed: messages.filter((m) => !m.success && !m.skipped).length,
    messages,
  };
}

/**
 * Dispatches whose updatedAt falls on IST calendar days [startDay, endDay] inclusive.
 * @param {{ deliveredOnly?: boolean }} opts - When true, only DELIVERED (for live sends).
 */
export async function findDispatchesBetween(startDay, endDay, { deliveredOnly = false } = {}) {
  const start = moment(startDay, "YYYY-MM-DD").utcOffset(330, true).startOf("day");
  const end = moment(endDay, "YYYY-MM-DD").utcOffset(330, true).endOf("day");
  const filter = {
    updatedAt: { $gte: start.toDate(), $lte: end.toDate() },
    transportStatus: { $ne: "CANCELLED" },
  };
  if (deliveredOnly) filter.transportStatus = "DELIVERED";
  return Dispatch.find(filter).sort({ updatedAt: -1 }).lean();
}

/** @deprecated use findDispatchesBetween with deliveredOnly */
export async function findDeliveredDispatchesBetween(startDay, endDay) {
  return findDispatchesBetween(startDay, endDay, { deliveredOnly: true });
}

/**
 * Dry-run or send for yesterday + day-before-yesterday (IST) by default.
 */
export async function runAfterDeliveryBatch({
  daysBack = 2,
  dryRun = true,
  endDaysAgo = 1,
  allowPending = false,
} = {}) {
  const endDay = ist().subtract(endDaysAgo, "days");
  const startDay = ist().subtract(endDaysAgo + daysBack - 1, "days");
  const startLabel = startDay.format("YYYY-MM-DD");
  const endLabel = endDay.format("YYYY-MM-DD");

  const dispatches = await findDispatchesBetween(startLabel, endLabel, {
    deliveredOnly: !dryRun && !allowPending,
  });

  const results = [];
  const allMessages = [];

  for (const d of dispatches) {
    const r = await sendAfterDeliveryForDispatch(d._id, { dryRun, allowPending });
    results.push(r);
    allMessages.push(...(r.messages || []));
  }

  return {
    window: { start: startLabel, end: endLabel, ist: true },
    dryRun,
    dispatchCount: dispatches.length,
    messageCount: allMessages.length,
    sendable: allMessages.filter((m) => !m.skipped && m.phone).length,
    skippedNoPhone: allMessages.filter((m) => m.skipped).length,
    dispatches: results,
    messages: allMessages,
  };
}

/** Fire-and-forget after complete-delivery form commits. */
export function scheduleAfterDeliveryWhatsAppForDispatch(dispatchId) {
  if (!dispatchId) return;
  setImmediate(async () => {
    try {
      const r = await sendAfterDeliveryForDispatch(dispatchId, { dryRun: false });
      console.log(
        `[after_delivery] dispatch ${dispatchId}: sent=${r.sent} skipped=${r.skipped} failed=${r.failed}`
      );
    } catch (e) {
      console.error("[after_delivery] dispatch", dispatchId, e?.message || e);
    }
  });
}

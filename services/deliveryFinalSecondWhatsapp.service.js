/**
 * Scheduled + on-demand sends for WATI template `delivery_final_second`.
 * Targets: past-due orders + orders with delivery exactly 7 days ahead (IST).
 */

import moment from "moment";
import Order from "../models/order.model.js";
import {
  sendDeliveryFinalSecondWhatsApp,
  formatDeliveryFinalSecondDate,
} from "../utility/watiMessaging.js";
import { storeFarmReadyTemplateSendMeta } from "./whatsappFarmReadyReschedule.service.js";
import { getWatiToken } from "../config/wati.config.js";

const IST = "+05:30";

export const DELIVERY_FINAL_SECOND_STATUSES = [
  "ACCEPTED",
  "FARM_READY",
  "READY_FOR_DISPATCH",
  "ASSIGNED",
  "PROCESSING",
];

export const DELIVERY_FINAL_TRIGGERS = {
  PAST_DUE: "past_due",
  DUE_IN_7_DAYS: "due_in_7_days",
  FARM_READY_STATUS: "farm_ready_status",
};

function istNow() {
  return moment().utcOffset(IST);
}

/** @returns {{ start: Date, end: Date }} */
export function istDayRange(daysFromToday = 0) {
  const start = istNow().clone().startOf("day").add(daysFromToday, "days");
  return { start: start.toDate(), end: start.clone().endOf("day").toDate() };
}

export function isPastDueDeliveryDate(deliveryDate, ref = istNow()) {
  if (!deliveryDate) return false;
  const d = moment(deliveryDate).utcOffset(IST).startOf("day");
  return d.isBefore(ref.clone().startOf("day"), "day");
}

export function isDeliveryDueInDays(deliveryDate, days = 7, ref = istNow()) {
  if (!deliveryDate) return false;
  const target = ref.clone().startOf("day").add(days, "days");
  const d = moment(deliveryDate).utcOffset(IST).startOf("day");
  return d.isSame(target, "day");
}

export function classifyDeliveryFinalSecondTrigger(deliveryDate, ref = istNow()) {
  if (!deliveryDate) return null;
  if (isPastDueDeliveryDate(deliveryDate, ref)) return DELIVERY_FINAL_TRIGGERS.PAST_DUE;
  if (isDeliveryDueInDays(deliveryDate, 7, ref)) return DELIVERY_FINAL_TRIGGERS.DUE_IN_7_DAYS;
  return null;
}

function cooldownMs() {
  const hours = parseInt(process.env.WATI_DELIVERY_FINAL_COOLDOWN_HOURS || "24", 10);
  return Math.max(1, hours) * 60 * 60 * 1000;
}

function isEnabled() {
  return process.env.WATI_DELIVERY_FINAL_SECOND_ENABLED !== "false";
}

function orderPlantQty(order) {
  return (Number(order.numberOfPlants) || 0) + (Number(order.additionalPlants) || 0);
}

function baseOrderFilter() {
  return {
    orderStatus: { $in: DELIVERY_FINAL_SECOND_STATUSES },
    deliveryDate: { $exists: true, $ne: null },
    dealerOrder: { $ne: true },
    farmer: { $exists: true, $ne: null },
  };
}

/**
 * @param {"past_due"|"due_in_7_days"} trigger
 */
export function buildDeliveryFinalSecondQuery(trigger, ref = istNow()) {
  const q = { ...baseOrderFilter() };
  const todayStart = ref.clone().startOf("day");

  if (trigger === DELIVERY_FINAL_TRIGGERS.PAST_DUE) {
    q.deliveryDate = { $lt: todayStart.toDate() };
  } else if (trigger === DELIVERY_FINAL_TRIGGERS.DUE_IN_7_DAYS) {
    const { start, end } = istDayRange(7);
    q.deliveryDate = { $gte: start, $lte: end };
  }

  const cooldownBefore = new Date(Date.now() - cooldownMs());
  q.$or = [
    { whatsappFarmReadySentAt: null },
    { whatsappFarmReadySentAt: { $exists: false } },
    { whatsappFarmReadySentAt: { $lt: cooldownBefore } },
  ];

  return q;
}

/**
 * Send delivery_final_second for one order (farmer must have mobile).
 */
export async function sendDeliveryFinalSecondForOrder(
  order,
  trigger = DELIVERY_FINAL_TRIGGERS.FARM_READY_STATUS
) {
  if (!getWatiToken()) {
    return { success: false, error: "WATI not configured" };
  }

  const orderDoc = await Order.findById(order._id || order.id)
    .populate("farmer", "name mobileNumber village")
    .populate("plantName", "name");

  if (!orderDoc) return { success: false, error: "order_not_found" };

  const farmerDoc = orderDoc.farmer;
  if (!farmerDoc?.mobileNumber) {
    return { success: false, error: "no_farmer_mobile" };
  }

  await Order.ensurePublicOrderCode(orderDoc);
  if (orderDoc.isModified?.("publicOrderCode")) {
    await orderDoc.save();
  }
  const plantName = orderDoc.plantName?.name || "Plants";
  const qty = orderPlantQty(orderDoc);

  const result = await sendDeliveryFinalSecondWhatsApp(farmerDoc, {
    publicOrderCode: orderDoc.publicOrderCode,
    orderId: orderDoc.orderId || orderDoc._id,
    plantName,
    numberOfPlants: qty,
    deliveryDate: orderDoc.deliveryDate,
  });

  if (result.success) {
    await Order.updateOne(
      { _id: orderDoc._id },
      {
        $set: {
          whatsappFarmReadySentAt: new Date(),
          whatsappDeliveryFinalSecondTrigger: trigger,
        },
      }
    );
    await storeFarmReadyTemplateSendMeta(
      orderDoc._id,
      result.data?.localMessageId || result.localMessageId
    );
  }

  return {
    ...result,
    orderId: String(orderDoc._id),
    trigger,
    publicOrderCode: orderDoc.publicOrderCode,
    deliveryDate: orderDoc.deliveryDate
      ? formatDeliveryFinalSecondDate(orderDoc.deliveryDate)
      : null,
  };
}

/**
 * Cron / manual scan — past due + due in 7 days.
 */
export async function runDeliveryFinalSecondScan() {
  if (!isEnabled()) {
    return { skipped: true, reason: "disabled" };
  }
  if (!getWatiToken()) {
    return { skipped: true, reason: "wati_not_configured" };
  }

  const summary = {
    pastDue: { matched: 0, sent: 0, failed: 0 },
    dueIn7Days: { matched: 0, sent: 0, failed: 0 },
    errors: [],
  };

  for (const trigger of [
    DELIVERY_FINAL_TRIGGERS.PAST_DUE,
    DELIVERY_FINAL_TRIGGERS.DUE_IN_7_DAYS,
  ]) {
    const bucket =
      trigger === DELIVERY_FINAL_TRIGGERS.PAST_DUE ? summary.pastDue : summary.dueIn7Days;
    const query = buildDeliveryFinalSecondQuery(trigger);
    const orders = await Order.find(query)
      .populate("farmer", "name mobileNumber village")
      .populate("plantName", "name")
      .limit(parseInt(process.env.WATI_DELIVERY_FINAL_SCAN_LIMIT || "200", 10))
      .lean();

    bucket.matched = orders.length;

    for (const order of orders) {
      try {
        const result = await sendDeliveryFinalSecondForOrder(order, trigger);
        if (result.success) bucket.sent += 1;
        else {
          bucket.failed += 1;
          if (summary.errors.length < 20) {
            summary.errors.push({
              orderId: String(order._id),
              trigger,
              error: result.error || "send_failed",
            });
          }
        }
      } catch (err) {
        bucket.failed += 1;
        if (summary.errors.length < 20) {
          summary.errors.push({
            orderId: String(order._id),
            trigger,
            error: err?.message || String(err),
          });
        }
      }
    }
  }

  return summary;
}

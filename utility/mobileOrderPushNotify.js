import User from "../models/user.model.js";
import {
  sendPaymentAcceptedNotification,
  sendPaymentRejectedNotification,
  sendPaymentPendingNotification,
  sendOrderAcceptedNotification,
  sendOrderDispatchedNotification,
} from "./pushNotification.js";
import { persistInboxOnce } from "./notificationInbox.js";

const notifyAsync = (fn, ...args) => {
  void fn(...args).catch((err) => {
    console.error("[mobileOrderPushNotify]", err?.message || err);
  });
};

export async function resolvePlantOrderNotifyUser(order) {
  const dealerId = order?.dealer?._id || order?.dealer;
  const salesPersonId = order?.salesPerson?._id || order?.salesPerson;

  if (dealerId) {
    return User.findById(dealerId).select("expoPushToken name").lean();
  }
  if (salesPersonId) {
    return User.findById(salesPersonId).select("expoPushToken name").lean();
  }
  return null;
}

export async function resolveAgriOrderNotifyUser(order) {
  const salesPersonId = order?.salesPerson?._id || order?.salesPerson;
  const createdById = order?.createdBy?._id || order?.createdBy;

  if (salesPersonId) {
    return User.findById(salesPersonId).select("expoPushToken name").lean();
  }
  if (createdById) {
    return User.findById(createdById).select("expoPushToken name").lean();
  }
  return null;
}

function plantOrderLabel(order) {
  return order?.orderId || String(order?._id || "");
}

function agriOrderLabel(order) {
  return order?.orderNumber || String(order?._id || "");
}

const PAYMENT_INBOX_COPY = {
  COLLECTED: { type: "payment_accepted", title: "पेमेंट स्वीकारले · Payment accepted" },
  BANK_VERIFIED: { type: "payment_accepted", title: "पेमेंट स्वीकारले · Payment accepted" },
  REJECTED: { type: "payment_rejected", title: "पेमेंट नाकारले · Payment rejected" },
};

async function persistPaymentInbox(user, order, orderLabel, paymentStatus, amount, remark) {
  const copy = PAYMENT_INBOX_COPY[paymentStatus];
  if (!user?._id || !copy) return;
  const amt = Number(amount || 0).toLocaleString("en-IN");
  const reason = paymentStatus === "REJECTED" && remark ? ` · ${remark}` : "";
  await persistInboxOnce({
    userId: user._id,
    title: copy.title,
    body: `₹${amt} · Order #${orderLabel}${reason}`,
    type: copy.type,
    data: { orderId: String(order?._id || ""), orderLabel: String(orderLabel), amount: Number(amount || 0), paymentStatus },
    dedupeKey: `order:${order?._id}:payment:${paymentStatus}:${Number(amount || 0)}`,
  });
}

export function notifyPlantOrderPaymentStatus(order, paymentStatus, amount, remark = "") {
  notifyAsync(async () => {
    const user = await resolvePlantOrderNotifyUser(order);
    await persistPaymentInbox(user, order, plantOrderLabel(order), paymentStatus, amount, remark);
    if (!user?.expoPushToken) return;

    const orderId = plantOrderLabel(order);
    if (paymentStatus === "COLLECTED" || paymentStatus === "BANK_VERIFIED") {
      await sendPaymentAcceptedNotification(user.expoPushToken, orderId, amount);
    } else if (paymentStatus === "REJECTED") {
      await sendPaymentRejectedNotification(user.expoPushToken, orderId, amount, remark);
    } else if (paymentStatus === "PENDING") {
      await sendPaymentPendingNotification(user.expoPushToken, orderId, amount);
    }
  });
}

export function notifyPlantOrderAccepted(order) {
  notifyAsync(async () => {
    const user = await resolvePlantOrderNotifyUser(order);
    if (!user?.expoPushToken) return;

    const orderId = plantOrderLabel(order);
    await sendOrderAcceptedNotification(user.expoPushToken, orderId, {
      plantName: order?.plantName?.name || "plants",
      quantity: order?.numberOfPlants || order?.quantity || 0,
    });
  });
}

export function notifyPlantOrderDispatched(order, dispatchDetails = {}) {
  notifyAsync(async () => {
    const user = await resolvePlantOrderNotifyUser(order);
    if (!user?.expoPushToken) return;

    const orderId = plantOrderLabel(order);
    await sendOrderDispatchedNotification(user.expoPushToken, orderId, dispatchDetails);
  });
}

export function notifyAgriOrderPaymentStatus(order, paymentStatus, amount, remark = "") {
  notifyAsync(async () => {
    const user = await resolveAgriOrderNotifyUser(order);
    await persistPaymentInbox(user, order, agriOrderLabel(order), paymentStatus, amount, remark);
    if (!user?.expoPushToken) return;

    const orderId = agriOrderLabel(order);
    if (paymentStatus === "COLLECTED" || paymentStatus === "BANK_VERIFIED") {
      await sendPaymentAcceptedNotification(user.expoPushToken, orderId, amount);
    } else if (paymentStatus === "REJECTED") {
      await sendPaymentRejectedNotification(user.expoPushToken, orderId, amount, remark);
    } else if (paymentStatus === "PENDING") {
      await sendPaymentPendingNotification(user.expoPushToken, orderId, amount);
    }
  });
}

export function notifyAgriOrderAccepted(order) {
  notifyAsync(async () => {
    const user = await resolveAgriOrderNotifyUser(order);
    if (!user?.expoPushToken) return;

    const orderId = agriOrderLabel(order);
    const productName =
      order?.productName ||
      order?.ramAgriCropName ||
      order?.lineItems?.[0]?.productName ||
      "products";

    await sendOrderAcceptedNotification(user.expoPushToken, orderId, {
      plantName: productName,
      quantity: order?.quantity || order?.lineItems?.reduce((s, l) => s + (l.quantity || 0), 0) || 0,
    });
  });
}

export function notifyAgriOrderDispatched(order, dispatchDetails = {}) {
  notifyAsync(async () => {
    const user = await resolveAgriOrderNotifyUser(order);
    if (!user?.expoPushToken) return;

    const orderId = agriOrderLabel(order);
    await sendOrderDispatchedNotification(user.expoPushToken, orderId, dispatchDetails);
  });
}

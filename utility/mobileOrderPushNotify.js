import User from "../models/user.model.js";
import {
  sendPaymentAcceptedNotification,
  sendPaymentRejectedNotification,
  sendPaymentPendingNotification,
  sendOrderAcceptedNotification,
  sendOrderDispatchedNotification,
} from "./pushNotification.js";

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

export function notifyPlantOrderPaymentStatus(order, paymentStatus, amount, remark = "") {
  notifyAsync(async () => {
    const user = await resolvePlantOrderNotifyUser(order);
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

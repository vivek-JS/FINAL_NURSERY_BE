/**
 * Farmer/customer WhatsApp on payment collected — same template as order placed.
 */

import Order from "../models/order.model.js";
import AgriSalesOrder from "../models/agriSalesOrder.model.js";
import PlantCms from "../models/plantCms.model.js";
import {
  sendOrderPlacedWhatsApp,
  buildWatiSendRecipient,
  watiDisplayOrderId,
} from "../utility/watiMessaging.js";
import { sendPaymentReceivedAlert } from "./whatsappAlertService.js";

const WATI_BLOCKED_ORDER_STATUSES = new Set(["PENDING", "REJECTED", "CANCELLED"]);

function watiDigitsOk(n) {
  return n != null && String(n).replace(/\D/g, "").length >= 10;
}

function resolveOrderTaluka(order) {
  const of = order?.orderFor;
  if (of && typeof of === "object") {
    const t = String(of.talukaName || of.taluka || "").trim();
    if (t) return t;
  }
  const farmer = order?.farmer;
  if (farmer && typeof farmer === "object") {
    const t = String(farmer.talukaName || farmer.taluka || "").trim();
    if (t) return t;
  }
  return "N/A";
}

function orderCustomerForTemplate(order) {
  const taluka = resolveOrderTaluka(order);
  const of = order?.orderFor;
  if (of && typeof of === "object" && String(of.name || "").trim()) {
    return {
      name: String(of.name).trim(),
      village: String(of.village || of.villageName || "").trim() || "N/A",
      taluka,
    };
  }
  const farmer = order?.farmer;
  if (farmer && String(farmer.name || "").trim()) {
    return {
      name: String(farmer.name).trim(),
      village: String(farmer.village || "").trim() || "N/A",
      taluka,
    };
  }
  return { name: "Customer", village: "N/A", taluka };
}

function farmerRecipient(order) {
  if (!order || order.dealerOrder) return null;
  const farmer = order.farmer;
  if (!farmer || !watiDigitsOk(farmer.mobileNumber)) return null;
  return farmer;
}

function dealerRecipient(order) {
  if (!order) return null;
  const sp = order.salesPerson;
  if (!sp || !watiDigitsOk(sp.phoneNumber)) return null;
  const customer = orderCustomerForTemplate(order);
  if (order.dealerOrder) {
    return {
      name: customer.name,
      village: customer.village,
      taluka: customer.taluka,
      mobileNumber: sp.phoneNumber,
    };
  }
  if (String(sp.jobTitle || "").toUpperCase() === "DEALER") {
    return {
      name: customer.name,
      village: customer.village,
      taluka: customer.taluka,
      mobileNumber: sp.phoneNumber,
    };
  }
  return null;
}

async function resolvePlantSubtypeName(order) {
  const subtypeId = order.plantSubtype;
  const plantRef = order.plantName;
  const plantId = plantRef?._id || plantRef;
  if (!plantId || !subtypeId) return "N/A";
  const plant = await PlantCms.findById(plantId).select("subtypes");
  if (!plant?.subtypes?.length) return "N/A";
  const sub = plant.subtypes.id(subtypeId);
  if (sub?.name) return sub.name;
  const sid = String(subtypeId);
  const found = plant.subtypes.find((s) => String(s._id) === sid);
  return found?.name || "N/A";
}

async function buildPlantOrderDetails(order) {
  if (!order.publicOrderCode) {
    await Order.ensurePublicOrderCode(order);
    await order.save();
  }
  const totalPlants = (order.numberOfPlants || 0) + (order.additionalPlants || 0);
  const totalAmount = totalPlants * (order.rate || 0);
  const paidAmount =
    order.payment
      ?.filter((p) => p.paymentStatus === "COLLECTED")
      .reduce((sum, p) => sum + (p.paidAmount || 0), 0) || 0;
  const plantSubtypeName = await resolvePlantSubtypeName(order);
  return {
    orderId: order.orderId,
    publicOrderCode: order.publicOrderCode,
    plantName: order.plantName?.name || "Plants",
    plantSubtype: plantSubtypeName,
    numberOfPlants: totalPlants,
    deliveryDate: order.deliveryDate,
    orderBookingDate: order.orderBookingDate,
    createdAt: order.createdAt,
    rate: order.rate,
    totalAmount,
    advanceAmount: paidAmount,
    remainingAmount: totalAmount - paidAmount,
    taluka: resolveOrderTaluka(order),
  };
}

async function sendPlacedTemplateToRecipient(recipient, orderDetails) {
  const sendTo = buildWatiSendRecipient(recipient, {
    taluka: recipient?.taluka || orderDetails.taluka || "N/A",
  });
  if (!sendTo) {
    return { success: false, error: "No valid mobile number" };
  }
  return sendOrderPlacedWhatsApp(sendTo, orderDetails);
}

function agriProductLabel(order) {
  if (order.lineItems?.length) {
    return order.lineItems
      .map((li) => li.productName || li.ramAgriVarietyName || li.ramAgriCropName)
      .filter(Boolean)
      .join(", ");
  }
  return (
    order.productName ||
    order.ramAgriVarietyName ||
    order.ramAgriCropName ||
    "Agri Product"
  );
}

function agriQuantity(order) {
  if (order.lineItems?.length) {
    return order.lineItems.reduce((s, li) => s + (Number(li.quantity) || 0), 0);
  }
  return Number(order.quantity) || 0;
}

function buildAgriOrderDetails(order) {
  const totalAmount = Number(order.totalAmount) || 0;
  const paidAmount =
    order.payment
      ?.filter((p) => p.paymentStatus === "COLLECTED")
      .reduce((sum, p) => sum + (p.paidAmount || 0), 0) || 0;
  const qty = agriQuantity(order);
  const rate = qty > 0 ? Math.round(totalAmount / qty) : order.rate || 0;
  return {
    orderId: order.orderNumber,
    publicOrderCode: order.orderNumber,
    plantName: agriProductLabel(order),
    plantSubtype: order.ramAgriVarietyName || "—",
    numberOfPlants: qty,
    deliveryDate: order.deliveryDate,
    orderBookingDate: order.orderDate,
    createdAt: order.createdAt,
    rate,
    totalAmount,
    advanceAmount: paidAmount,
    remainingAmount: Math.max(0, totalAmount - paidAmount),
    taluka: order.customerTaluka || "N/A",
  };
}

function agriCustomerRecipient(order) {
  if (!watiDigitsOk(order?.customerMobile)) return null;
  return {
    name: order.customerName || "Customer",
    village: order.customerVillage || "N/A",
    taluka: order.customerTaluka || "N/A",
    mobileNumber: order.customerMobile,
  };
}

/**
 * @param {string|import('mongoose').Types.ObjectId} orderId
 * @param {{ paidAmount?: number, modeOfPayment?: string }} [paymentInfo]
 */
export async function tryAutoSendPlantOrderPaymentWhatsApp(orderId, paymentInfo = {}) {
  if (process.env.WATI_PAYMENT_WHATSAPP_ENABLED === "false") {
    return { skipped: true, reason: "disabled" };
  }
  try {
    const order = await Order.findById(orderId)
      .populate("farmer", "name mobileNumber village taluka talukaName")
      .populate("salesPerson", "name phoneNumber jobTitle")
      .populate("plantName", "name");
    if (!order) {
      console.warn(`[WATI payment] Order not found: ${orderId}`);
      return { skipped: true, reason: "not_found" };
    }
    const status = String(order.orderStatus || "").toUpperCase();
    if (WATI_BLOCKED_ORDER_STATUSES.has(status)) {
      return { skipped: true, reason: `order_status_${status}` };
    }
    if (!order.payment?.some((p) => p.paymentStatus === "COLLECTED")) {
      return { skipped: true, reason: "no_collected_payment" };
    }

    const orderDetails = await buildPlantOrderDetails(order);
    const recipient = order.dealerOrder ? dealerRecipient(order) : farmerRecipient(order);
    if (!recipient) {
      console.warn(
        `[WATI payment] No WhatsApp recipient for Order #${order.orderId || order._id}`
      );
      return { skipped: true, reason: "no_recipient" };
    }

    const result = await sendPlacedTemplateToRecipient(recipient, orderDetails);
    if (result.success) {
      console.log(
        `✅ [WATI payment] Sent order_placed template for Order #${order.orderId || order._id}`
      );
    } else {
      console.warn(
        `⚠️ [WATI payment] Failed for Order #${order.orderId || order._id}:`,
        result.error?.message || result.error
      );
    }

    void sendPaymentReceivedAlert({
      farmer: order.farmer,
      customerName: recipient.name,
      paidAmount: paymentInfo.paidAmount,
      amount: paymentInfo.paidAmount,
      modeOfPayment: paymentInfo.modeOfPayment,
      orderNumber: watiDisplayOrderId(orderDetails),
      order,
    }).catch((e) => console.error("[WhatsApp Alert] payment:", e?.message || e));

    return result;
  } catch (err) {
    console.error(`❌ [WATI payment] Error for order ${orderId}:`, err?.message || err);
    return { success: false, error: err?.message || String(err) };
  }
}

/**
 * @param {string|import('mongoose').Types.ObjectId} orderId
 * @param {{ paidAmount?: number, modeOfPayment?: string }} [paymentInfo]
 */
export async function tryAutoSendAgriOrderPaymentWhatsApp(orderId, paymentInfo = {}) {
  if (process.env.WATI_PAYMENT_WHATSAPP_ENABLED === "false") {
    return { skipped: true, reason: "disabled" };
  }
  try {
    const order = await AgriSalesOrder.findById(orderId);
    if (!order) {
      console.warn(`[WATI agri payment] Order not found: ${orderId}`);
      return { skipped: true, reason: "not_found" };
    }
    if (!order.payment?.some((p) => p.paymentStatus === "COLLECTED")) {
      return { skipped: true, reason: "no_collected_payment" };
    }

    const recipient = agriCustomerRecipient(order);
    if (!recipient) {
      console.warn(
        `[WATI agri payment] No customer mobile for order ${order.orderNumber || orderId}`
      );
      return { skipped: true, reason: "no_recipient" };
    }

    const orderDetails = buildAgriOrderDetails(order);
    const result = await sendPlacedTemplateToRecipient(recipient, orderDetails);
    if (result.success) {
      console.log(
        `✅ [WATI agri payment] Sent for Agri order ${order.orderNumber || orderId}`
      );
    } else {
      console.warn(
        `⚠️ [WATI agri payment] Failed for ${order.orderNumber || orderId}:`,
        result.error?.message || result.error
      );
    }

    void sendPaymentReceivedAlert({
      customerName: order.customerName,
      paidAmount: paymentInfo.paidAmount,
      amount: paymentInfo.paidAmount,
      modeOfPayment: paymentInfo.modeOfPayment,
      orderNumber: order.orderNumber,
      order,
    }).catch((e) => console.error("[WhatsApp Alert] agri payment:", e?.message || e));

    return result;
  } catch (err) {
    console.error(`❌ [WATI agri payment] Error for ${orderId}:`, err?.message || err);
    return { success: false, error: err?.message || String(err) };
  }
}

export function schedulePlantOrderPaymentWhatsApp(orderId, paymentInfo = {}) {
  if (!orderId) return;
  void tryAutoSendPlantOrderPaymentWhatsApp(orderId, paymentInfo);
}

export function scheduleAgriOrderPaymentWhatsApp(orderId, paymentInfo = {}) {
  if (!orderId) return;
  void tryAutoSendAgriOrderPaymentWhatsApp(orderId, paymentInfo);
}

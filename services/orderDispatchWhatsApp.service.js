import Order from "../models/order.model.js";
import PlantCms from "../models/plantCms.model.js";
import Dispatch from "../models/dispatch.model.js";
import { sendOrderDispatchedWhatsAppDelivery1 } from "../utility/watiMessaging.js";

function watiDigitsOk(n) {
  return n != null && String(n).replace(/\D/g, "").length >= 10;
}

function watiPhoneKey(n) {
  const d = String(n).replace(/\D/g, "");
  if (d.length >= 12 && d.startsWith("91")) return d.slice(-10);
  return d.slice(-10);
}

function watiPhonesDiffer(a, b) {
  if (!watiDigitsOk(a) || !watiDigitsOk(b)) return true;
  return watiPhoneKey(a) !== watiPhoneKey(b);
}

function farmerWhatsAppRecipient(order) {
  if (!order || order.dealerOrder) return null;
  const farmer = order.farmer;
  if (!farmer || !watiDigitsOk(farmer.mobileNumber)) return null;
  return farmer;
}

function resolveOrderTalukaForWati(order) {
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

function orderCustomerForWatiTemplate(order) {
  const taluka = resolveOrderTalukaForWati(order);
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

function dealerWhatsAppRecipient(order) {
  if (!order) return null;
  const sp = order.salesPerson;
  if (!sp || !watiDigitsOk(sp.phoneNumber)) return null;
  const customer = orderCustomerForWatiTemplate(order);
  if (order.dealerOrder) {
    return {
      name: customer.name,
      village: customer.village,
      taluka: customer.taluka,
      mobileNumber: sp.phoneNumber,
      sendToName: sp.name || "Dealer",
    };
  }
  if (String(sp.jobTitle || "").toUpperCase() === "DEALER") {
    return {
      name: customer.name,
      village: customer.village,
      taluka: customer.taluka,
      mobileNumber: sp.phoneNumber,
      sendToName: sp.name || "Dealer",
    };
  }
  return null;
}

function extractWatiLocalMessageId(payload) {
  if (!payload || typeof payload !== "object") return null;
  return (
    payload.local_message_id ||
    payload.localMessageId ||
    (payload.data && (payload.data.local_message_id || payload.data.localMessageId)) ||
    null
  );
}

async function resolveOrderPlantSubtypeName(order) {
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

async function resolveDriverMobileFromDispatch(latest) {
  if (!latest) return null;
  if (watiDigitsOk(latest.driverMobile)) return String(latest.driverMobile);
  const dispatchId = latest.dispatchId;
  if (!dispatchId) return null;
  try {
    const doc = await Dispatch.findById(dispatchId).select("driverMobile").lean();
    return watiDigitsOk(doc?.driverMobile) ? String(doc.driverMobile) : null;
  } catch {
    return null;
  }
}

async function resolveDispatchVehicleFromHistory(latest) {
  if (!latest?.dispatchId) return { vehicleName: null, vehicleNumber: null, driverName: null };
  try {
    const doc = await Dispatch.findById(latest.dispatchId)
      .select("vehicleName vehicleNumber driverName driverMobile")
      .lean();
    if (!doc) return { vehicleName: null, vehicleNumber: null, driverName: null };
    return {
      vehicleName: doc.vehicleName || null,
      vehicleNumber: doc.vehicleNumber || null,
      driverName: doc.driverName || null,
      driverMobile: doc.driverMobile || null,
    };
  } catch {
    return { vehicleName: null, vehicleNumber: null, driverName: null };
  }
}

async function buildDispatchWhatsAppDetails(order) {
  const history = Array.isArray(order.dispatchHistory) ? order.dispatchHistory : [];
  const dispatchedSum = history.reduce((s, h) => s + (Number(h.quantity) || 0), 0);
  const totalPlants = (order.numberOfPlants || 0) + (order.additionalPlants || 0);
  const totalDispatched =
    dispatchedSum > 0 ? dispatchedSum : order.orderStatus === "DISPATCHED" ? totalPlants : 0;
  const latest = history.length > 0 ? history[history.length - 1] : null;
  const dispatchVehicle = await resolveDispatchVehicleFromHistory(latest);
  const driverMobile =
    (await resolveDriverMobileFromDispatch(latest)) ||
    dispatchVehicle.driverMobile ||
    latest?.driverMobile ||
    latest?.dispatch?.driverMobile ||
    "N/A";
  const plantSubtypeName = await resolveOrderPlantSubtypeName(order);
  const vehicleLabel =
    dispatchVehicle.vehicleNumber ||
    dispatchVehicle.vehicleName ||
    latest?.vehicleName ||
    "N/A";
  return {
    totalDispatched,
    details: {
      orderId: order.orderId,
      publicOrderCode: order.publicOrderCode,
      plantName: order.plantName?.name || "Plants",
      plantSubtype: plantSubtypeName,
      totalDispatched,
      driverName: dispatchVehicle.driverName || latest?.driverName || "N/A",
      driverNumber: driverMobile,
      vehicleNumber: vehicleLabel,
      dispatchDate: latest?.date || new Date(),
      deliveryDate: order.deliveryDate,
    },
  };
}

/**
 * Send farmer/dealer dispatch WhatsApp once per order (WATI delivery_final_revamp).
 * @returns {Promise<{ sent?, alreadySent?, skipped?, reason?, error?, whatsappDispatchSentAt?, whatsappDispatchMessageKey?, farmerSent?, dealerSent?, dealerAlsoSent?, dealerSendWarning? }>}
 */
export async function ensureOrderDispatchWhatsAppOnce(orderId, { allowManualResend = false } = {}) {
  const order = await Order.findById(orderId)
    .populate("farmer", "name mobileNumber village taluka talukaName")
    .populate("salesPerson", "name phoneNumber jobTitle")
    .populate("plantName", "name");
  if (!order) {
    return { skipped: true, reason: "order_not_found" };
  }
  if (order.whatsappDispatchSentAt && !allowManualResend) {
    return {
      alreadySent: true,
      whatsappDispatchSentAt: order.whatsappDispatchSentAt,
      whatsappDispatchMessageKey: order.whatsappDispatchMessageKey || null,
    };
  }

  const { totalDispatched, details } = await buildDispatchWhatsAppDetails(order);
  if (totalDispatched <= 0) {
    return { skipped: true, reason: "no_dispatch_recorded" };
  }

  if (!order.publicOrderCode) {
    await Order.ensurePublicOrderCode(order);
    await order.save();
    details.publicOrderCode = order.publicOrderCode;
  }

  if (order.dealerOrder) {
    const dealerRec = dealerWhatsAppRecipient(order);
    if (!dealerRec) {
      return { skipped: true, reason: "dealer_no_phone" };
    }
    const result = await sendOrderDispatchedWhatsAppDelivery1(dealerRec, details);
    if (!result.success) {
      return { skipped: true, reason: "wati_failed", error: result.error };
    }
    order.whatsappDispatchSentAt = new Date();
    const msgKey = extractWatiLocalMessageId(result.data);
    if (msgKey) order.whatsappDispatchMessageKey = String(msgKey);
    await order.save();
    return {
      sent: true,
      farmerSent: false,
      dealerSent: true,
      whatsappDispatchSentAt: order.whatsappDispatchSentAt,
      whatsappDispatchMessageKey: order.whatsappDispatchMessageKey || null,
    };
  }

  const farmerRec = farmerWhatsAppRecipient(order);
  if (!farmerRec) {
    return { skipped: true, reason: "farmer_no_phone" };
  }
  const farmerResult = await sendOrderDispatchedWhatsAppDelivery1(farmerRec, details);
  if (!farmerResult.success) {
    return { skipped: true, reason: "wati_failed", error: farmerResult.error };
  }
  order.whatsappDispatchSentAt = new Date();
  const farmerMsgKey = extractWatiLocalMessageId(farmerResult.data);
  if (farmerMsgKey) order.whatsappDispatchMessageKey = String(farmerMsgKey);
  await order.save();

  let dealerAlsoSent = false;
  let dealerSendNote = null;
  const dealerRec = dealerWhatsAppRecipient(order);
  if (dealerRec && watiPhonesDiffer(farmerRec.mobileNumber, dealerRec.mobileNumber)) {
    const dealerResult = await sendOrderDispatchedWhatsAppDelivery1(dealerRec, details);
    dealerAlsoSent = Boolean(dealerResult.success);
    if (!dealerResult.success) {
      dealerSendNote =
        dealerResult.error?.message ||
        (typeof dealerResult.error === "string" ? dealerResult.error : "Dealer copy failed");
    }
  }

  return {
    sent: true,
    farmerSent: true,
    dealerAlsoSent,
    ...(dealerSendNote ? { dealerSendWarning: dealerSendNote } : {}),
    whatsappDispatchSentAt: order.whatsappDispatchSentAt,
    whatsappDispatchMessageKey: order.whatsappDispatchMessageKey || null,
  };
}

/** Fire-and-forget dispatch WhatsApp after DC PDF (never throws to caller). */
export function scheduleEnsureOrderDispatchWhatsApp(orderId) {
  if (!orderId) return;
  setImmediate(() => {
    ensureOrderDispatchWhatsAppOnce(orderId, { allowManualResend: false }).catch((err) => {
      console.error(
        `[scheduleEnsureOrderDispatchWhatsApp] order=${orderId}:`,
        err?.message || err
      );
    });
  });
}

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
  let totalDispatched;
  let latest;
  if (order.vehicleLoaded && Number(order.vehicleLoadedQuantity) > 0) {
    totalDispatched = Number(order.vehicleLoadedQuantity);
    latest = { dispatchId: order.vehicleLoadedDispatchId, date: order.vehicleLoadedAt };
  } else {
    const dispatchedSum = history.reduce((s, h) => s + (Number(h.quantity) || 0), 0);
    const totalPlants = (order.numberOfPlants || 0) + (order.additionalPlants || 0);
    totalDispatched =
      dispatchedSum > 0 ? dispatchedSum : order.orderStatus === "DISPATCHED" ? totalPlants : 0;
    latest = history.length > 0 ? history[history.length - 1] : null;
  }
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
 * Atomically reserve this send so concurrent triggers (post-load hook, vehicle scan, DC PDF)
 * do not double-message. Returns a release() that undoes the claim when the send fails.
 */
async function claimDispatchWhatsAppSend(order, { shedTracked, loadedQty, allowManualResend }) {
  if (allowManualResend) return { claimed: true, release: async () => {} };
  if (shedTracked) {
    const prevQty = order.whatsappDispatchSentQty ?? null;
    const res = await Order.updateOne(
      { _id: order._id, whatsappDispatchSentQty: { $ne: loadedQty } },
      { $set: { whatsappDispatchSentQty: loadedQty } }
    );
    return {
      claimed: res.modifiedCount > 0,
      release: () =>
        Order.updateOne(
          { _id: order._id, whatsappDispatchSentQty: loadedQty },
          { $set: { whatsappDispatchSentQty: prevQty } }
        ),
    };
  }
  const res = await Order.updateOne(
    { _id: order._id, whatsappDispatchSentAt: null },
    { $set: { whatsappDispatchSentAt: new Date() } }
  );
  return {
    claimed: res.modifiedCount > 0,
    release: () =>
      Order.updateOne({ _id: order._id }, { $set: { whatsappDispatchSentAt: null } }),
  };
}

/**
 * Farmer/dealer dispatch WhatsApp (WATI delivery_final_revamp; papaya uses driver_fianl).
 * Shed-loaded orders: send whenever vehicleLoadedQuantity differs from the qty in the last message
 * (first load, unload+reload to a new qty, office qty edit + refill). Not sent while unloaded.
 * Orders never loaded through the shed: send once (legacy office dispatch flow).
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

  const shedTracked = Boolean(order.vehicleLoaded || order.vehicleLoadedDispatchId);
  const loadedQty = Math.max(0, Number(order.vehicleLoadedQuantity) || 0);
  const alreadySentResult = {
    alreadySent: true,
    whatsappDispatchSentAt: order.whatsappDispatchSentAt,
    whatsappDispatchMessageKey: order.whatsappDispatchMessageKey || null,
  };

  if (!allowManualResend) {
    if (shedTracked && !order.vehicleLoaded) {
      return { skipped: true, reason: "vehicle_not_loaded" };
    }
    if (shedTracked && order.whatsappDispatchSentQty === loadedQty) return alreadySentResult;
    if (!shedTracked && order.whatsappDispatchSentAt) return alreadySentResult;
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

  const recipient = order.dealerOrder ? dealerWhatsAppRecipient(order) : farmerWhatsAppRecipient(order);
  if (!recipient) {
    return { skipped: true, reason: order.dealerOrder ? "dealer_no_phone" : "farmer_no_phone" };
  }

  const claim = await claimDispatchWhatsAppSend(order, {
    shedTracked,
    loadedQty,
    allowManualResend,
  });
  if (!claim.claimed) return alreadySentResult;

  const send = (rec) => sendOrderDispatchedWhatsAppDelivery1(rec, details);

  const primaryResult = await send(recipient);
  if (!primaryResult.success) {
    await claim.release();
    return { skipped: true, reason: "wati_failed", error: primaryResult.error };
  }

  const sentAt = new Date();
  const msgKey = extractWatiLocalMessageId(primaryResult.data);
  await Order.updateOne(
    { _id: order._id },
    {
      $set: {
        whatsappDispatchSentAt: sentAt,
        ...(shedTracked ? { whatsappDispatchSentQty: loadedQty } : {}),
        ...(msgKey ? { whatsappDispatchMessageKey: String(msgKey) } : {}),
      },
      $inc: { whatsappDispatchSendCount: 1 },
    }
  );
  const sentFields = {
    whatsappDispatchSentAt: sentAt,
    whatsappDispatchMessageKey: msgKey ? String(msgKey) : order.whatsappDispatchMessageKey || null,
  };

  if (order.dealerOrder) {
    return { sent: true, farmerSent: false, dealerSent: true, ...sentFields };
  }

  let dealerAlsoSent = false;
  let dealerSendNote = null;
  const dealerRec = dealerWhatsAppRecipient(order);
  if (dealerRec && watiPhonesDiffer(recipient.mobileNumber, dealerRec.mobileNumber)) {
    const dealerResult = await send(dealerRec);
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
    ...sentFields,
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

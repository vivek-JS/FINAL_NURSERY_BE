import { Parser as CsvParser } from "json2csv";
import catchAsync from "../utility/catchAsync.js";
import Order from "../models/order.model.js";
import PlantCms from "../models/plantCms.model.js";
import { getAll, createOne, updateOne } from "./factory.controller.js";
import DealerWallet from "../models/dealerWallet.js";
import { resolveDealerCashBalance } from "../utils/dealerWalletBalance.js";
import Dispatch from "../models/dispatch.model.js";
import AppError from "../utility/appError.js";
import generateResponse from "../utility/responseFormat.js";
import mongoose from "mongoose";
import User from "../models/user.model.js";
import Farmer from "../models/farmer.model.js";
import Tray from "../models/tray.model.js";
import PaymentActivity from "../models/paymentActivity.model.js";
import {
  sendPaymentAcceptedNotification,
  sendPaymentRejectedNotification,
  sendPaymentCollectedNotification,
  sendPaymentPendingNotification,
} from "../utility/pushNotification.js";
import {
  sendOrderAcceptedWhatsApp,
  sendOrderDispatchedWhatsAppDelivery1,
  buildWatiSendRecipient,
} from "../utility/watiMessaging.js";
import { isBananaPlantName } from "../utility/watiPlantText.js";
import { getUnclearedPayments as getUnclearedPaymentsService, getPaymentsForApproval as getPaymentsForApprovalService, reconcile as reconcileService } from "../services/paymentReconciliationService.js";
import { generateQR } from "../services/iciciBankService.js";
import { normalizeIciciError, saveIciciQrAuditRecord } from "../services/iciciQr.service.js";
import {
  ensureFarmerPlantOrderDebit,
  recordFarmerPlantLedgerPaymentTransition,
  getFarmerPlantPaymentTransitionAction,
  shouldLogFarmerPlantLedger,
} from "../utils/farmerPlantOrderLedgerHelper.js";
import {
  syncDealerLedgerForOrder,
} from "../utils/dealerLedgerHelper.js";
import { appendStatusChangeToUpdate } from "../utils/orderStatusAuditHelper.js";
import { fetchAdminDailyMis } from "../services/adminDailyMis.service.js";
import {
  resolveOrderStatusTokens,
  buildOrderStatusDateMatch,
} from "../utility/orderListQuery.js";
import FarmerOrderTransferRequest from "../models/farmerOrderTransferRequest.model.js";
import {
  approveFarmerOrderTransferRequest,
  rejectFarmerOrderTransferRequest,
} from "./farmerPlantOrderLedger.controller.js";
import { applyPaymentTimingToPayment } from "../utils/paymentTiming.js";

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

/** Farmer — required for WhatsApp on non–dealer orders. */
function farmerWhatsAppRecipient(order) {
  if (!order || order.dealerOrder) return null;
  const farmer = order.farmer;
  if (!farmer || !watiDigitsOk(farmer.mobileNumber)) return null;
  return farmer;
}

/**
 * Customer shown in WATI template body (farmer / book-for name), not the WhatsApp recipient.
 */
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
      village:
        String(of.village || of.villageName || "").trim() ||
        "N/A",
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

/**
 * Dealer / salesperson copy: message goes TO dealer phone; template uses farmer/customer name.
 */
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

/** Subtype is ObjectId into PlantCms.subtypes (no ref on Order) — resolve name for WATI. */
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

const WATI_BLOCKED_ORDER_STATUSES_FOR_ACCEPT = new Set([
  "PENDING",
  "REJECTED",
  "CANCELLED",
]);

function acceptedWhatsAppAutoSendSkipReason(order, plantSubtypeName = "") {
  if (!order) return "no_order";
  if (order.whatsappAcceptedSentAt) return "already_sent";
  const status = String(order.orderStatus || "").toUpperCase();
  if (WATI_BLOCKED_ORDER_STATUSES_FOR_ACCEPT.has(status)) return `order_status_${status}`;
  const hasCollected =
    order.payment?.some((p) => p.paymentStatus === "COLLECTED") ?? false;
  if (!hasCollected) return "no_collected_payment";
  if (!isBananaPlantName(order.plantName?.name || "", plantSubtypeName)) {
    return "not_banana";
  }
  return null;
}

/** Schedule auto WATI for Banana only — full plant/subtype check runs in tryAutoSend after populate. */
function maybeScheduleAcceptedWhatsAppAfterCollect(order) {
  if (!order?._id || order.whatsappAcceptedSentAt) return;
  const status = String(order.orderStatus || "").toUpperCase();
  if (WATI_BLOCKED_ORDER_STATUSES_FOR_ACCEPT.has(status)) return;
  if (!order.payment?.some((p) => p.paymentStatus === "COLLECTED")) return;
  scheduleAutoSendOrderAcceptedWhatsApp(order._id);
}

async function buildOrderAcceptedWhatsAppDetails(order) {
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
  const remainingAmount = totalAmount - paidAmount;
  const plantSubtypeName = await resolveOrderPlantSubtypeName(order);
  return {
    orderId: order.orderId || order._id,
    publicOrderCode: order.publicOrderCode,
    plantName: order.plantName?.name || "Plants",
    plantSubtype: plantSubtypeName,
    numberOfPlants: totalPlants,
    deliveryDate: order.deliveryDate,
    rate: order.rate,
    totalAmount,
    advanceAmount: paidAmount,
    remainingAmount,
    taluka: resolveOrderTalukaForWati(order),
  };
}

async function sendOrderAcceptedWhatsAppForOrder(order) {
  if (order.whatsappAcceptedSentAt) {
    return {
      success: true,
      alreadySent: true,
      whatsappAcceptedSentAt: order.whatsappAcceptedSentAt,
      whatsappAcceptedMessageKey: order.whatsappAcceptedMessageKey || null,
    };
  }

  const orderDetails = await buildOrderAcceptedWhatsAppDetails(order);

  const watiTaluka = orderDetails.taluka || resolveOrderTalukaForWati(order);

  if (order.dealerOrder) {
    const dealerRec = dealerWhatsAppRecipient(order);
    if (!dealerRec) {
      return {
        success: false,
        error: {
          message:
            "Dealer order has no salesperson with a valid mobile number for WhatsApp",
        },
      };
    }
    const dealerSendTo = buildWatiSendRecipient(dealerRec, { taluka: watiTaluka });
    if (!dealerSendTo) {
      return {
        success: false,
        error: { message: "Dealer has no valid phone number for WhatsApp" },
      };
    }
    const result = await sendOrderAcceptedWhatsApp(dealerSendTo, orderDetails);
    if (result.success) {
      order.whatsappAcceptedSentAt = new Date();
      const msgKey = extractWatiLocalMessageId(result.data);
      if (msgKey) order.whatsappAcceptedMessageKey = String(msgKey);
      await order.save();
      return {
        success: true,
        data: result.data,
        farmerSent: false,
        dealerSent: true,
        stored: {
          whatsappAcceptedSentAt: order.whatsappAcceptedSentAt,
          whatsappAcceptedMessageKey: order.whatsappAcceptedMessageKey || null,
        },
      };
    }
    return { success: false, error: result.error };
  }

  const farmerRec = farmerWhatsAppRecipient(order);
  if (!farmerRec) {
    return {
      success: false,
      error: {
        message:
          "Order has no farmer with mobile number — farmer WhatsApp is required for this order",
      },
    };
  }
  const farmerSendTo = buildWatiSendRecipient(farmerRec, { taluka: watiTaluka });
  if (!farmerSendTo) {
    return {
      success: false,
      error: {
        message:
          "Order has no farmer with mobile number — farmer WhatsApp is required for this order",
      },
    };
  }
  const farmerResult = await sendOrderAcceptedWhatsApp(farmerSendTo, orderDetails);
  if (!farmerResult.success) {
    return { success: false, error: farmerResult.error };
  }
  order.whatsappAcceptedSentAt = new Date();
  const farmerMsgKey = extractWatiLocalMessageId(farmerResult.data);
  if (farmerMsgKey) order.whatsappAcceptedMessageKey = String(farmerMsgKey);
  await order.save();

  let dealerAlsoSent = false;
  let dealerSendNote = null;
  const dealerRec = dealerWhatsAppRecipient(order);
  if (dealerRec && watiPhonesDiffer(farmerRec.mobileNumber, dealerRec.mobileNumber)) {
    const dealerCopySendTo = buildWatiSendRecipient(dealerRec, { taluka: watiTaluka });
    const dealerResult = dealerCopySendTo
      ? await sendOrderAcceptedWhatsApp(dealerCopySendTo, orderDetails)
      : { success: false, error: "No mobile number" };
    dealerAlsoSent = Boolean(dealerResult.success);
    if (!dealerResult.success) {
      dealerSendNote =
        dealerResult.error?.message ||
        (typeof dealerResult.error === "string" ? dealerResult.error : "Dealer copy failed");
    }
  }

  return {
    success: true,
    data: farmerResult.data,
    farmerSent: true,
    dealerAlsoSent,
    dealerSendNote,
    stored: {
      whatsappAcceptedSentAt: order.whatsappAcceptedSentAt,
      whatsappAcceptedMessageKey: order.whatsappAcceptedMessageKey || null,
    },
  };
}

/** Auto-send order_accpeted_revamped once when first payment is COLLECTED (fire-and-forget safe). */
export async function tryAutoSendOrderAcceptedWhatsApp(orderId) {
  try {
    const order = await Order.findById(orderId)
      .populate("farmer", "name mobileNumber village taluka talukaName")
      .populate("salesPerson", "name phoneNumber jobTitle")
      .populate("plantName", "name");
    if (!order) {
      console.warn(`[WATI accept] Order not found: ${orderId}`);
      return;
    }
    const plantSubtypeName = await resolveOrderPlantSubtypeName(order);
    const skipReason = acceptedWhatsAppAutoSendSkipReason(order, plantSubtypeName);
    if (skipReason) {
      console.log(
        `[WATI accept] Skipped auto-send for Order #${order.orderId || order._id}: ${skipReason}`
      );
      return;
    }
    const result = await sendOrderAcceptedWhatsAppForOrder(order);
    if (result.success && !result.alreadySent) {
      console.log(
        `✅ [WATI accept] Auto-sent for Order #${order.orderId || order._id}`
      );
    } else if (!result.success) {
      console.warn(
        `⚠️ [WATI accept] Auto-send failed for Order #${order.orderId || order._id}:`,
        result.error?.message || result.error
      );
    }
  } catch (err) {
    console.error(
      `❌ [WATI accept] Auto-send error for order ${orderId}:`,
      err?.message || err
    );
  }
}

function scheduleAutoSendOrderAcceptedWhatsApp(orderId) {
  if (!orderId) return;
  void tryAutoSendOrderAcceptedWhatsApp(orderId);
}

const DEBUG_ENDPOINT = "http://127.0.0.1:7242/ingest/44347468-0193-498c-9d04-ef8c3f7959e9";
const DEBUG_SESSION_ID = "69bde0";
const DEBUG_RUN_ID = "due-before-after-investigation";

function debugLog(hypothesisId, location, message, data = {}) {
  // #region agent log
  fetch(DEBUG_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Debug-Session-Id": DEBUG_SESSION_ID,
    },
    body: JSON.stringify({
      sessionId: DEBUG_SESSION_ID,
      runId: DEBUG_RUN_ID,
      hypothesisId,
      location,
      message,
      data,
      timestamp: Date.now(),
    }),
  }).catch(() => {});
  // #endregion
}

/** Numeric business order id (Order.orderId) — query must match stored Number type. */
function parseBusinessOrderId(raw) {
  if (raw == null || raw === "") return NaN;
  const n = typeof raw === "number" ? raw : Number(String(raw).trim());
  return Number.isFinite(n) ? Math.trunc(n) : NaN;
}

function findPaymentSubdocument(order, paymentId) {
  if (!order?.payment?.length) return null;
  if (paymentId == null || paymentId === "") return null;
  let p = order.payment.id(paymentId);
  if (p) return p;
  const s = String(paymentId).trim();
  if (mongoose.Types.ObjectId.isValid(s)) {
    const oid = new mongoose.Types.ObjectId(s);
    p = order.payment.id(oid);
    if (p) return p;
  }
  return order.payment.find((x) => x?._id && String(x._id) === s);
}

const updateDealerWalletBalance = async (dealerId, paymentAmount, description = "Wallet balance adjustment", performedBy = null) => {
  // Validate dealerId
  if (!dealerId) {
    throw new Error("Dealer ID is required for wallet operations");
  }

  // Convert to ObjectId if it's a string
  const dealerObjectId = typeof dealerId === 'string' ? new mongoose.Types.ObjectId(dealerId) : dealerId;
  
  let wallet = await DealerWallet.findOne({ dealer: dealerObjectId });

  if (!wallet) {
    console.log('Creating new wallet for dealer:', dealerObjectId);
    wallet = new DealerWallet({
      dealer: dealerObjectId,
      availableAmount: paymentAmount,
      entries: [],
      transactions: []
    });
    await wallet.save();
  } else {
    // Record transaction before updating balance
    if (paymentAmount !== 0) {
      const transaction = await DealerWallet.addPayment(
        dealerObjectId,
        paymentAmount,
        description,
        performedBy || dealerObjectId,
        "PAYMENT_STATUS_UPDATE",
        null
      );
    }
  }
};
const createDealerOrder = createOne(Order, "Order");
const getOrdersBySlot = catchAsync(async (req, res, next) => {
  const { slotId } = req.params; // Extract the slotId from the request parameters

  try {
    // Use aggregation to properly handle subdocument references
    const orders = await Order.aggregate([
      {
        $match: { bookingSlot: new mongoose.Types.ObjectId(slotId) }
      },
      {
        $lookup: {
          from: "farmers",
          localField: "farmer",
          foreignField: "_id",
          as: "farmer"
        }
      },
      {
        $lookup: {
          from: "users",
          localField: "salesPerson",
          foreignField: "_id",
          as: "salesPerson"
        }
      },
      {
        $lookup: {
          from: "plantcms",
          localField: "plantName",
          foreignField: "_id",
          as: "plantName"
        }
      },
      {
        $lookup: {
          from: "plantcms",
          localField: "plantSubtype",
          foreignField: "subtypes._id",
          as: "plantSubtypeData"
        }
      },
      {
        $lookup: {
          from: "plantslots",
          localField: "bookingSlot",
          foreignField: "subtypeSlots._id",
          as: "slotData"
        }
      },
      {
        $unwind: { path: "$farmer", preserveNullAndEmptyArrays: true }
      },
      {
        $unwind: { path: "$salesPerson", preserveNullAndEmptyArrays: true }
      },
      {
        $unwind: { path: "$plantName", preserveNullAndEmptyArrays: true }
      },
      {
        $unwind: { path: "$plantSubtypeData", preserveNullAndEmptyArrays: true }
      },
      {
        $unwind: { path: "$slotData", preserveNullAndEmptyArrays: true }
      },
      {
        $addFields: {
          // Extract the matching subtype from the plantSubtypeData
          plantSubtype: {
            $arrayElemAt: [
              {
                $filter: {
                  input: { $ifNull: ["$plantSubtypeData.subtypes", []] },
                  as: "subtype",
                  cond: { $eq: ["$$subtype._id", "$plantSubtype"] }
                }
              },
              0
            ]
          },
          // Extract the matching slot from slotData
          bookingSlotData: {
            $arrayElemAt: [
              {
                $filter: {
                  input: { $ifNull: ["$slotData.subtypeSlots", []] },
                  as: "slot",
                  cond: { $eq: ["$$slot._id", "$bookingSlot"] }
                }
              },
              0
            ]
          }
        }
      }
    ]);

    if (!orders || orders.length === 0) {
      return res
        .status(404)
        .json({ message: "No orders found for the specified slot." });
    }

    // Send all the order details along with populated references as a response
    return res.status(200).json({
      message: "Orders fetched successfully.",
      orders: orders.map((order) => {
        return {
          id: order._id, // Returning the order ID
          _id: order._id, // The same as the `id` field in your sample
          farmer: {
            _id: order.farmer?._id,
            name: order.farmer?.name,
            village: order.farmer?.village,
            taluka: order.farmer?.taluka,
            district: order.farmer?.district,
            mobileNumber: order.farmer?.mobileNumber,
          },
          salesPerson: {
            _id: order.salesPerson?._id,
            name: order.salesPerson?.name,
            phoneNumber: order.salesPerson?.phoneNumber,
          },
          numberOfPlants: order?.numberOfPlants,
          plantName: order?.plantName?.name,
          plantSubtype: order?.plantSubtype?.name,
          bookingSlot: {
            _id: order?.bookingSlot?._id,
            startDay: order?.bookingSlot?.startDay,
            endDay: order?.bookingSlot?.endDay,
            totalPlants: order?.bookingSlot?.totalPlants,
            totalBookedPlants: order?.bookingSlot?.totalBookedPlants,
            orders: order?.bookingSlot?.orders,
            overflow: order?.bookingSlot?.overflow,
            status: order?.bookingSlot?.status,
            month: order?.bookingSlot?.month,
          },
          rate: order?.rate,
          orderPaymentStatus: order?.orderPaymentStatus,
          orderStatus: order?.orderStatus,
          payment: order?.payment,
          createdAt: order?.createdAt,
          updatedAt: order?.updatedAt,
          orderBookingDate: order?.orderBookingDate, // Order booking date
          deliveryDate: order?.deliveryDate, // Specific delivery date
          salesPersonName: order.salesPerson?.name, // salesPersonName
          salesPersonPhoneNumber: order.salesPerson?.phoneNumber, // salesPersonPhoneNumber
          orderFor: order?.orderFor, // Add orderFor field
        };
      }),
    });
  } catch (error) {
    console.error("Error fetching orders by slot:", error);
    return res
      .status(500)
      .json({ message: "An error occurred while fetching orders.", error });
  }
});

// export { getOrdersBySlot };

const getCsv = catchAsync(async (req, res, next) => {
  try {
    const { startDate, endDate, orderStatus, paymentStatus } = req.query;

    let query = {};

    if (startDate && endDate) {
      const start = new Date(startDate);
      start.setHours(0, 0, 0, 0);
      const end = new Date(endDate);
      end.setHours(23, 59, 59, 999);
      query.$or = [
        { orderBookingDate: { $gte: start, $lte: end } },
        {
          $and: [
            {
              $or: [
                { orderBookingDate: null },
                { orderBookingDate: { $exists: false } },
              ],
            },
            { createdAt: { $gte: start, $lte: end } },
          ],
        },
      ];
    }

    if (orderStatus) {
      const statuses = String(orderStatus)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      if (statuses.length > 1) {
        query.orderStatus = { $in: statuses };
      } else if (statuses.length === 1) {
        query.orderStatus = statuses[0];
      }
    }

    if (paymentStatus) {
      query.orderPaymentStatus = paymentStatus;
    }

    const ordersLean = await Order.find(query)
      .populate("salesPerson", "name phoneNumber")
      .populate("plantName", "name subtypes")
      .populate("dealer", "name")
      .sort({ orderBookingDate: -1, createdAt: -1 })
      .lean();

    if (!ordersLean || ordersLean.length === 0) {
      return next(new AppError("No orders found for the specified criteria", 404));
    }

    const farmerIdStrings = [
      ...new Set(
        ordersLean
          .map((o) => o.farmer)
          .filter((id) => id != null)
          .map((id) => String(id))
      ),
    ];
    const farmerDocs =
      farmerIdStrings.length > 0
        ? await Farmer.find({ _id: { $in: farmerIdStrings } })
            .select(
              "name mobileNumber village taluka district districtName talukaName state stateName"
            )
            .lean()
        : [];
    const farmerById = new Map(farmerDocs.map((fr) => [String(fr._id), fr]));

    const jsonData = ordersLean;

    const csvFields = [
      "Sr No",
      "Order ID",
      "Booking date",
      "Farmer name",
      "Mobile No",
      "District",
      "Taluka",
      "Village",
      "Variety",
      "Plant",
      "Booked plants",
      "Returned plants",
      "Damaged plants",
      "Billable plants (net)",
      "Rate",
      "Delivery date",
      "Dispatched",
      "Dispatched date",
      "Order status",
      "Reference",
    ];

    let srNo = 0;
    const csvData = [];

    const formatInDate = (d) =>
      d ? new Date(d).toLocaleDateString("en-IN") : "N/A";

    const deliverySource = (obj) =>
      obj.deliveryDate || obj.farmReadyDate || null;

    const latestDispatchInfo = (obj) => {
      const hist = Array.isArray(obj.dispatchHistory) ? obj.dispatchHistory : [];
      if (!hist.length) {
        return { dispatched: obj.orderStatus === "DISPATCHED" ? "Y" : "N", date: null };
      }
      const latest = hist[hist.length - 1];
      const d = latest?.dispatchDate || latest?.dispatchedAt || latest?.createdAt || null;
      return { dispatched: "Y", date: d };
    };

    const csvMobile = (farmerDoc, orderFor) => {
      const n =
        farmerDoc?.mobileNumber ??
        orderFor?.mobileNumber ??
        undefined;
      if (n === undefined || n === null || n === "" || n === 0) return "N/A";
      return String(n);
    };

    jsonData.forEach((obj) => {
      try {
        const farmerId = obj.farmer != null ? String(obj.farmer) : null;
        const f = farmerId ? farmerById.get(farmerId) : null;
        const of = obj.orderFor;
        const bookingRef = obj.orderBookingDate || obj.createdAt;
        const subtypeName = obj.plantSubtype
          ? obj.plantName?.subtypes?.find(
              (st) => st._id.toString() === obj.plantSubtype.toString()
            )?.name || "N/A"
          : "N/A";

        const refParts = [];
        if (obj.dealer?.name) refParts.push(obj.dealer.name);
        if (obj.salesPerson?.name) refParts.push(obj.salesPerson.name);
        const reference = refParts.length ? refParts.join(" / ") : "N/A";

        const basePlants = Number(obj.numberOfPlants) || 0;
        const extraPlants = Number(obj.additionalPlants) || 0;
        const bookedTotal =
          obj.totalPlants != null && obj.totalPlants !== ""
            ? Number(obj.totalPlants)
            : basePlants + extraPlants;
        const ret = Number(obj.returnedPlants) || 0;
        const dmg = Number(obj.damagedPlants) || 0;
        const billable = Math.max(0, (Number.isFinite(bookedTotal) ? bookedTotal : 0) - ret - dmg);
        const dispatchInfo = latestDispatchInfo(obj);

        // Farmer may be unset (dealer / legacy rows); use orderFor for customer + address fallback.
        const addr =
          typeof of?.address === "string" && of.address.trim()
            ? of.address.trim()
            : "";

        let district = "N/A";
        let taluka = "N/A";
        let village = "N/A";
        if (f) {
          district = f.districtName || f.district || "N/A";
          taluka = f.talukaName || f.taluka || "N/A";
          village = f.village || (addr || "N/A");
        } else if (of?.districtName || of?.district || of?.village) {
          district = of.districtName || of.district || "N/A";
          taluka = of.talukaName || of.taluka || "N/A";
          village = of.village || addr || "N/A";
        } else if (addr) {
          village = addr;
        }

        csvData.push({
          "Sr No": ++srNo,
          "Order ID": obj.orderId != null ? obj.orderId : "",
          "Booking date": formatInDate(bookingRef),
          "Farmer name": f?.name || of?.name || "N/A",
          "Mobile No": csvMobile(f, of),
          District: district,
          Taluka: taluka,
          Village: village,
          Variety: obj.plantName?.name || "N/A",
          Plant: subtypeName,
          "Booked plants": Number.isFinite(bookedTotal) ? bookedTotal : "",
          "Returned plants": ret,
          "Damaged plants": dmg,
          "Billable plants (net)": billable,
          Rate: obj.rate ?? 0,
          "Delivery date": formatInDate(deliverySource(obj)),
          Dispatched: dispatchInfo.dispatched,
          "Dispatched date": formatInDate(dispatchInfo.date),
          "Order status": obj.orderStatus ?? "",
          Reference: reference,
        });
      } catch (error) {
        console.error("Error processing order:", obj._id, error);
      }
    });

    const norm = (d) => (d ? String(d).split("T")[0] : "");
    const rangePart =
      startDate && endDate
        ? `${norm(startDate)}_to_${norm(endDate)}`
        : "all_dates";
    const exportedOn = new Date().toISOString().split("T")[0];
    const filename = `farmer_orders_${rangePart}_exported_${exportedOn}.csv`;

    const csvParse = new CsvParser({ fields: csvFields });
    const csvDataParsed = csvParse.parse(csvData);

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.status(200).end(csvDataParsed);
  } catch (error) {
    console.error("CSV Export - Error:", error);
    return next(new AppError("Error generating CSV: " + error.message, 500));
  }
});

const getOrders = getAll(Order, "Order");

/** Allowed query keys copied onto each internal getOrders tab count (mirrors dashboard filters). */
function pickDashboardCountBaseQuery(q) {
  const allow = new Set([
    "search",
    "startDate",
    "endDate",
    "dateRangeField",
    "salesPerson",
    "dealer",
    "village",
    "district",
    "taluka",
    "plantId",
    "subtypeId",
    "includePastDueBeyondRange",
    "showonly",
  ]);
  const base = {};
  for (const [k, v] of Object.entries(q || {})) {
    if (!allow.has(k) || v === "" || v === undefined || v === null) continue;
    base[k] = v;
  }
  if (q?.q && !base.search) base.search = q.q;
  return base;
}

function mergeDashboardTabQuery(base, tab, queueFarmReadyOnly) {
  const q = { ...base, page: "1", limit: "1" };
  delete q.ready_for_dispatch;
  delete q.farmReady;
  delete q.status;
  delete q.dispatched;
  delete q.sortKey;
  delete q.sortOrder;

  const isCancelledTab = tab === "cancelled";
  const isBookingLikeTab =
    tab === "booking" ||
    tab === "pending" ||
    tab === "accepted" ||
    isCancelledTab;
  const isReadyForDispatchTab = tab === "ready_for_dispatch";
  const isCompletedTab = tab === "completed";

  q.dispatched = isBookingLikeTab ? "false" : "true";

  const searchTrimmed = String(q.search ?? "").trim();

  if (isCancelledTab) {
    q.status = "CANCELLED,TEMPORARY_CANCELLED";
  } else if (tab === "pending") {
    q.status = "PENDING";
  } else if (tab === "accepted") {
    q.status = "ACCEPTED,ASSIGNED";
  }

  if (tab === "farmready") {
    q.farmReady = "true";
    delete q.status;
  }

  if (isReadyForDispatchTab) {
    q.ready_for_dispatch = "true";
    delete q.startDate;
    delete q.endDate;
    delete q.status;
    if (queueFarmReadyOnly && !searchTrimmed) {
      q.farmReady = "true";
      q.sortKey = "farmReadyEnteredAt";
      q.sortOrder = "asc";
    }
  }

  if (tab === "dispatch_process") {
    delete q.startDate;
    delete q.endDate;
    q.status = "DISPATCH_PROCESS";
    q.dispatched = "false";
  }

  if (isCompletedTab) {
    q.dispatched = "true";
    q.status = "COMPLETED,PARTIALLY_COMPLETED";
  }

  Object.keys(q).forEach((k) => {
    if (q[k] === "" || q[k] === undefined || q[k] === null) delete q[k];
  });
  return q;
}

function invokeGetOrdersForDashboardCount(req, query) {
  return new Promise((resolve, reject) => {
    const mockReq = { query, user: req.user };
    const mockRes = {
      status() {
        return this;
      },
      json(payload) {
        const inner = payload?.data;
        const total =
          inner && typeof inner.total === "number"
            ? inner.total
            : Array.isArray(inner?.data)
              ? inner.data.length
              : 0;
        resolve(total);
      },
    };
    getOrders(mockReq, mockRes, (err) => {
      if (err) reject(err);
    });
  });
}

/**
 * GET /order/dashboard-tab-counts — non-paginated tab badge totals for FarmerOrdersTable.
 * Reuses getOrders filter logic via internal count-only calls (page/limit=1).
 */
const getFarmerOrdersDashboardTabCounts = catchAsync(async (req, res, next) => {
  const base = pickDashboardCountBaseQuery(req.query);
  const queueFarmReadyOnly = String(req.query.queueFarmReadyOnly ?? "") === "true";

  const tabs = [
    "booking",
    "pending",
    "accepted",
    "cancelled",
    "farmready",
    "ready_for_dispatch",
    "completed",
  ];

  const counts = {};
  for (const tab of tabs) {
    const q = mergeDashboardTabQuery(base, tab, queueFarmReadyOnly);
    counts[tab] = await invokeGetOrdersForDashboardCount(req, q);
  }

  const qIn = mergeDashboardTabQuery(base, "dispatch_process", queueFarmReadyOnly);
  const qDisp = { ...qIn, dispatched: "true", status: "ACCEPTED,FARM_READY" };
  delete qDisp.startDate;
  delete qDisp.endDate;

  const [nIn, nDisp] = await Promise.all([
    invokeGetOrdersForDashboardCount(req, qIn),
    invokeGetOrdersForDashboardCount(req, qDisp),
  ]);
  counts.dispatch_process = nIn + nDisp;

  return res
    .status(200)
    .json(generateResponse("Success", "Dashboard tab counts", counts, undefined));
});

const createOrder = createOne(Order, "Order");
const updateOrder = updateOne(Order, "Order", [
  "bookingSlot",
  "plantSubtype",
  "numberOfPlants",
  "quantity", // Alias for numberOfPlants
  "rate",
  "salesPerson",
  "orderPaymentStatus",
  "notes",
  "farmReadyDate",
  "orderStatus",
  "orderRemarks",
  "farmReadyDateChangeReason",
  "farmReadyDateChangeNotes",
  "deliveryDate", // Specific delivery date
  "dispatchDayKey",
  "dispatchTargetDate",
  "callHistory", // Call history for dispatch managers
  "cavity", // Tray ref — was omitted from whitelist, so some orders never persisted cavity
  "orderFor", // Book-for-someone-else (editable until order is terminal)
  "expectedNursery", // Nursery site code from CMS (RB, GH, …)
  "batchNumber", // Lot / batch from complete-delivery form or manual edit
  "deliveryChallanInvoiceNumber", // Legacy / manual DC label when dispatch legs have no sequenced invoice #
  "freightCharges", // Per-order freight at delivery complete
]);
/**
 * Add a new payment to an order and update dealer wallet accordingly
 */
const validateDealerId = (dealerId) => {
  if (!dealerId) return null;

  try {
    return mongoose.Types.ObjectId(dealerId);
  } catch (err) {
    console.error("Invalid dealer ID format:", dealerId);
    return null;
  }
};
const addNewPayment = catchAsync(async (req, res, next) => {
  console.log("\n========== PAYMENT CONTROLLER DEBUGGING ==========");
  console.log("Request params:", req.params);
  console.log("Request body:", req.body);
  console.log("Request file:", req.file);

  const { orderId } = req.params;
  const {
    paidAmount,
    paymentStatus,
    paymentDate,
    bankName,
    receiptPhoto,
    modeOfPayment,
    isWalletPayment,
    remark,
    transactionId,
    chequeNumber,
    utrNumber,
    customerName,
  } = req.body;

  // Handle uploaded screenshot file with Cloudinary
  let screenshotUrl = null;
  if (req.file) {
    try {
      const { uploadImageToLocalStorage } = await import('../utils/localStorageUtils.js');
      const uploadResult = await uploadImageToLocalStorage(
        req.file.buffer,
        'nursery-orders/payments',
        { mimetype: req.file.mimetype }
      );
      
      if (uploadResult.success) {
        screenshotUrl = uploadResult.url;
        console.log("Screenshot uploaded to local storage:", screenshotUrl);
      } else {
        console.error("Failed to upload screenshot to local storage:", uploadResult.error);
      }
    } catch (error) {
      console.error("Error uploading screenshot to local storage:", error);
    }
  }

  try {
    // Find the order and populate farmer details
    console.log("Finding order with ID:", orderId);
    const order = await Order.findById(orderId)
      .populate("farmer", "name village mobileNumber taluka talukaName")
      .populate("plantName", "name");
    if (!order) {
      console.error("Order not found");
      return res.status(404).json({ message: "Order not found" });
    }

    console.log("Order found:");
    console.log("- ID:", order._id);
    console.log("- Dealer:", order.dealer);
    console.log("- Dealer Type:", typeof order.dealer);
    console.log("- Sales Person:", order.salesPerson);
    console.log("- isDealerOrder:", order.dealerOrder);

    // Check if order has a dealer
    if (!order.dealer) {
      console.warn("Order has no dealer field, will check salesPerson");
    }

    // Convert paidAmount to number
    const amount = Number(paidAmount);
    if (isNaN(amount)) {
      console.error("Invalid payment amount");
      return res.status(400).json({ message: "Invalid payment amount" });
    }

    // Set payment status based on payment type and user role
    // Prioritize jobTitle over role
    const userRole = req.user?.jobTitle || req.user?.role;
    let finalPaymentStatus = "PENDING"; // Default to PENDING for new payments
    const canMarkPaymentCollected =
      userRole === "ACCOUNTANT" ||
      userRole === "SUPER_ADMIN" ||
      userRole === "SUPERADMIN";

    // OFFICE_ADMIN: always PENDING. Others: only accountant/super-admin may set COLLECTED.
    if (userRole === "OFFICE_ADMIN") {
      finalPaymentStatus = "PENDING";
      console.log("OFFICE_ADMIN payment - forcing status to PENDING");
    } else if (
      canMarkPaymentCollected &&
      paymentStatus &&
      (paymentStatus === "COLLECTED" || paymentStatus === "PENDING")
    ) {
      finalPaymentStatus = paymentStatus;
      console.log("Using requested payment status:", finalPaymentStatus);
    } else {
      console.log("Using default payment status: PENDING");
    }

    console.log("Payment details:");
    console.log("- Amount:", amount);
    console.log("- Requested Status:", paymentStatus);
    console.log("- Final Status:", finalPaymentStatus);
    console.log("- User Role:", userRole);
    console.log("- Is wallet payment:", isWalletPayment ? "Yes" : "No");
    console.log("- Mode:", modeOfPayment);
    console.log("- Payment will be saved with status:", finalPaymentStatus);

    // Create the payment object
    const newPayment = {
      paidAmount: amount,
      paymentStatus: finalPaymentStatus, // Use the determined status
      paymentDate,
      bankName,
      receiptPhoto: screenshotUrl ? [screenshotUrl] : (receiptPhoto || []), // Use uploaded screenshot or existing receiptPhoto
      modeOfPayment,
      isWalletPayment,
      remark: remark || "",
      transactionId: transactionId || undefined,
      chequeNumber: chequeNumber || undefined,
      utrNumber: utrNumber?.trim() || undefined,
      customerName:
        customerName?.trim() ||
        (!order.dealerOrder && order.farmer?.name ? order.farmer.name : undefined),
    };
    
    console.log("Created payment object with status:", newPayment.paymentStatus);
    applyPaymentTimingToPayment(newPayment, order);

    // Extract farmer details BEFORE saving (to avoid losing populated data)
    console.log("DEBUG: Farmer data check BEFORE saving:");
    console.log("- order.dealerOrder:", order.dealerOrder);
    console.log("- order.farmer:", order.farmer);
    console.log("- order.farmer type:", typeof order.farmer);
    console.log("- order.farmer name:", order.farmer?.name);
    console.log("- order.farmer village:", order.farmer?.village);
    
    let farmerInfo = 'Unknown Customer';
    if (order.dealerOrder) {
      // For dealer orders, use dealer info instead of farmer
      farmerInfo = 'Dealer Order';
      console.log("DEBUG: Using Dealer Order for description");
    } else if (order.farmer && typeof order.farmer === 'object' && order.farmer.name) {
      // For farmer orders, use farmer name and village
      const farmerName = order.farmer.name || 'Unknown Farmer';
      const farmerVillage = order.farmer.village || 'Unknown Village';
      farmerInfo = `${farmerName} (${farmerVillage})`;
      console.log("DEBUG: Using farmer info:", farmerInfo);
    } else {
      console.log("DEBUG: No farmer data found, using Unknown Customer");
    }

    // Add the payment to order
    console.log("Adding payment to order");
    order.payment.push(newPayment);

    // Save the order with the new payment
    console.log("Saving order...");
    await order.save();
    console.log("Order saved successfully");

    const savedPayment = order.payment[order.payment.length - 1];
    if (savedPayment) {
      const { emitPlantPaymentEvent } = await import("../utils/orderEventDualWrite.js");
      emitPlantPaymentEvent(order._id, savedPayment, {
        userId: req.user?._id,
        actorName: req.user?.name,
      }).catch((e) => console.error("[OrderEvent] payment emit:", e?.message || e));
    }

    // Process wallet transaction if needed
    let transaction = null;
    
    // Get dealer ID from order.dealer or from salesPerson if they are a dealer
    let dealerId = order.dealer;
    
    // If no dealer field, check if salesPerson is a dealer
    if (!dealerId && order.salesPerson) {
      try {
        // Fetch the sales person to check their jobTitle
        const salesPerson = await User.findById(order.salesPerson);
        if (salesPerson && salesPerson.jobTitle === 'DEALER') {
          dealerId = salesPerson._id;
          console.log("Found dealer from salesPerson:", dealerId);
        }
      } catch (error) {
        console.error("Error fetching sales person:", error);
      }
    }

    if (dealerId) {
      console.log("Processing wallet transaction for dealer:", dealerId);
      try {
        // First, debug the current wallet state
        console.log("Checking current wallet state for dealer:", dealerId);
        await DealerWallet.debugWallet(dealerId);

        // Determine transaction type and amount
        let walletAmount = 0;
        let description = "";

        // Wallet impact based on payment type and status
        // PENDING and COLLECTED payments should impact wallet balance
        if (isWalletPayment && (finalPaymentStatus === "PENDING" || finalPaymentStatus === "COLLECTED")) {
          // Deduct from wallet (negative amount) - when dealer pays from wallet (pending or collected)
          walletAmount = -amount;
          description = `Wallet payment ${finalPaymentStatus.toLowerCase()} for Order #${order._id} - ${farmerInfo}`;
          console.log(`This is a ${finalPaymentStatus.toLowerCase()} wallet payment, deducting amount from wallet`);
        } else if (order.dealerOrder && isWalletPayment && (finalPaymentStatus === "PENDING" || finalPaymentStatus === "COLLECTED")) {
          // Special case: Dealer order with wallet payment (pending or collected)
          walletAmount = -amount;
          description = `Wallet payment ${finalPaymentStatus.toLowerCase()} for Dealer Order #${order._id} - ${farmerInfo}`;
          console.log(`This is a dealer wallet payment being ${finalPaymentStatus.toLowerCase()}`);
        } else {
          // Non-wallet payments or other statuses should NOT impact wallet balance
          walletAmount = 0;
          description = `Payment recorded (no wallet impact) for Order #${order._id} - ${farmerInfo}`;
          console.log("This payment has no wallet impact");
          console.log("Debug info:");
          console.log("- isWalletPayment:", isWalletPayment);
          console.log("- finalPaymentStatus:", finalPaymentStatus);
          console.log("- order.dealerOrder:", order.dealerOrder);
        }

        // If there's a wallet impact, record the transaction
        if (walletAmount !== 0) {
          console.log(
            `Recording wallet transaction: amount=${walletAmount}, description="${description}"`
          );

          const performedBy = req.user?._id || dealerId;
          console.log("Transaction performed by:", performedBy);

          // Use the addPayment method
          transaction = await DealerWallet.addPayment(
            dealerId,
            walletAmount, // Positive for credit, negative for debit
            description,
            performedBy,
            "ORDER_PAYMENT",
            order._id
          );

          // Check transaction result
          if (transaction) {
            console.log("Transaction recorded successfully:");
            console.log("- Type:", transaction.type);
            console.log("- Amount:", transaction.amount);
            console.log("- Balance After:", transaction.balanceAfter);
          } else {
            console.error(
              "Failed to record transaction - null result returned"
            );
          }

          // Debug wallet state after transaction
          console.log("Checking wallet state after transaction:");
          await DealerWallet.debugWallet(dealerId);
        }
      } catch (walletError) {
        // Log the error but don't fail the payment addition
        console.error("Error updating wallet:", walletError);

        return res.status(200).json({
          message: "Payment added to order but wallet update failed",
          error: walletError.message,
          updatedOrder: order,
        });
      }
    } else {
      console.log(
        "No dealer found (neither order.dealer nor salesPerson as dealer), skipping wallet transaction"
      );
    }

    if (shouldLogFarmerPlantLedger(order)) {
      try {
        await ensureFarmerPlantOrderDebit(order, { userId: req.user?._id });
        const lastPayment = order.payment[order.payment.length - 1];
        await recordFarmerPlantLedgerPaymentTransition(
          order,
          lastPayment,
          null,
          lastPayment.paymentStatus,
          { userId: req.user?._id }
        );
      } catch (farmerLedgerErr) {
        console.error("Farmer plant ledger (add payment):", farmerLedgerErr);
      }
    }

    try {
      await syncDealerLedgerForOrder(order, { userId: req.user?._id });
    } catch (dealerLedgerErr) {
      console.error("Dealer ledger sync (add payment):", dealerLedgerErr);
    }

    if (finalPaymentStatus === "COLLECTED") {
      maybeScheduleAcceptedWhatsAppAfterCollect(order);
    }

    // Return success with transaction info if it was created
    if (transaction) {
      console.log("Returning success response with transaction");
      console.log(
        "========== PAYMENT CONTROLLER DEBUGGING COMPLETE ==========\n"
      );
      return res.status(200).json({
        message: "Payment added successfully and wallet updated",
        updatedOrder: order,
        transaction,
      });
    }

    // Return success if no wallet transaction was needed
    console.log("Returning success response without transaction");
    console.log(
      "========== PAYMENT CONTROLLER DEBUGGING COMPLETE ==========\n"
    );
    return res.status(200).json({
      message: "Payment added successfully",
      updatedOrder: order,
    });
  } catch (error) {
    console.error("Error adding payment:", error);
    console.log(
      "========== PAYMENT CONTROLLER DEBUGGING COMPLETE ==========\n"
    );
    return res.status(500).json({
      message: "Server error while processing payment",
      error: error.message,
      stack: process.env.NODE_ENV === "development" ? error.stack : undefined,
    });
  }
});

/**
 * Alternative implementation using the simpler addPayment helper method
 */
const addNewPaymentAlternative = catchAsync(async (req, res, next) => {
  const { orderId } = req.params;
  const {
    paidAmount,
    paymentStatus,
    paymentDate,
    bankName,
    receiptPhoto,
    modeOfPayment,
    isWalletPayment,
  } = req.body;

  try {
    // Find the order and populate farmer details
    const order = await Order.findById(orderId).populate('farmer', 'name village');
    if (!order) {
      return res.status(404).json({ message: "Order not found" });
    }
    
    console.log("DEBUG: Order after population:");
    console.log("- order.farmer:", order.farmer);
    console.log("- order.farmer type:", typeof order.farmer);
    console.log("- order.farmer name:", order.farmer?.name);
    console.log("- order.farmer village:", order.farmer?.village);

    // Convert paidAmount to number
    const amount = Number(paidAmount);
    if (isNaN(amount)) {
      return res.status(400).json({ message: "Invalid payment amount" });
    }

    // Create the payment object
    const newPayment = {
      paidAmount: amount,
      paymentStatus,
      paymentDate,
      bankName,
      receiptPhoto,
      modeOfPayment,
      isWalletPayment,
    };
    applyPaymentTimingToPayment(newPayment, order);

    // Add the payment to order
    order.payment.push(newPayment);
    await order.save();

    // Process wallet transaction if needed
    if (order.dealer) {
      let walletAmount = 0;
      let description = "";

      // Get farmer details for description
      let farmerInfo = 'Unknown Customer';
      if (order.dealerOrder) {
        // For dealer orders, use dealer info instead of farmer
        farmerInfo = 'Dealer Order';
      } else if (order.farmer) {
        // For farmer orders, use farmer name and village
        const farmerName = order.farmer.name || 'Unknown Farmer';
        const farmerVillage = order.farmer.village || 'Unknown Village';
        farmerInfo = `${farmerName} (${farmerVillage})`;
      }

      // Determine the wallet impact
      if (isWalletPayment && (paymentStatus === "PENDING" || paymentStatus === "COLLECTED")) {
        // Deduct from wallet (negative amount) - for both pending and collected wallet payments
        walletAmount = -amount;
        description = `Wallet payment ${paymentStatus.toLowerCase()} for Order #${order._id} - ${farmerInfo}`;
      }

      // Process the wallet transaction if there is an impact
      if (walletAmount !== 0) {
        try {
          // Use the simpler addPayment method that handles positive/negative amounts
          const transaction = await DealerWallet.addPayment(
            order.dealer,
            walletAmount, // Positive for credit, negative for debit
            description,
            req.user._id,
            "ORDER_PAYMENT",
            order._id
          );

          return res.status(200).json({
            message: "Payment added successfully and wallet updated",
            updatedOrder: order,
            transaction,
          });
        } catch (walletError) {
          console.error("Error updating wallet:", walletError);
          return res.status(200).json({
            message: "Payment added successfully but wallet update failed",
            updatedOrder: order,
            walletError: walletError.message,
          });
        }
      }
    }

    // Return success if no wallet transaction was needed
    return res.status(200).json({
      message: "Payment added successfully",
      updatedOrder: order,
    });
  } catch (error) {
    console.error("Error adding payment:", error);
    return res
      .status(500)
      .json({ message: "Server error", error: error.message });
  }
});

const updatePaymentStatus = async (req, res) => {
  try {
    const { 
      orderId, 
      paymentId, 
      paymentStatus, 
      paidAmount, 
      paymentDate, 
      modeOfPayment, 
      bankName, 
      remark,
      transactionId,
      utrNumber,
      chequeNumber,
    } = req.body;

    if (orderId == null || orderId === "" || !paymentId || !paymentStatus) {
      return res.status(400).json({
        message: "Order ID, Payment ID, and Payment Status are required.",
      });
    }

    const orderIdNum = parseBusinessOrderId(orderId);
    if (!Number.isFinite(orderIdNum)) {
      return res.status(400).json({ message: "Invalid order id." });
    }

    // Find order by orderId field (numeric) instead of _id (ObjectId)
    const order = await Order.findOne({ orderId: orderIdNum })
      .populate("farmer", "name village mobileNumber taluka talukaName")
      .populate("plantName", "name");
    if (!order) {
      return res.status(404).json({ message: "Order not found." });
    }

    // Debug: Log order details (can be removed in production)
    console.log('Order found for payment status update:', {
      orderId: order._id,
      orderNumber: order.orderId,
      dealerOrder: order.dealerOrder,
      hasDealer: !!order.dealer,
      hasSalesPerson: !!order.salesPerson,
      hasFarmer: !!order.farmer
    });

    const payment = findPaymentSubdocument(order, paymentId);
    if (!payment) {
      return res.status(404).json({ message: "Payment not found." });
    }

    // Transfer-request payments: approve/reject via full transfer flow (source deduction + ledger).
    if (
      payment.transferRequestId &&
      payment.paymentStatus === "PENDING" &&
      (paymentStatus === "COLLECTED" || paymentStatus === "REJECTED")
    ) {
      const transferReq = await FarmerOrderTransferRequest.findById(payment.transferRequestId).lean();
      if (transferReq && transferReq.status === "PENDING") {
        req.params = { ...(req.params || {}), id: String(transferReq._id) };
        if (paymentStatus === "COLLECTED") {
          return approveFarmerOrderTransferRequest(req, res, next);
        }
        req.body = {
          ...(req.body || {}),
          reason: remark || req.body?.reason || "Rejected from payment dashboard",
        };
        return rejectFarmerOrderTransferRequest(req, res, next);
      }
    }

    // Update payment fields if provided
    if (paidAmount !== undefined) {
      payment.paidAmount = Number(paidAmount);
    }
    if (paymentDate !== undefined) {
      payment.paymentDate = new Date(paymentDate);
    }
    if (modeOfPayment !== undefined) {
      payment.modeOfPayment = modeOfPayment;
    }
    if (bankName !== undefined) {
      payment.bankName = bankName;
    }
    if (remark !== undefined) {
      payment.remark = remark;
    }
    if (transactionId !== undefined) {
      payment.transactionId = transactionId;
    }
    if (utrNumber !== undefined) {
      payment.utrNumber = utrNumber?.trim() || undefined;
    }
    if (chequeNumber !== undefined) {
      payment.chequeNumber = chequeNumber;
    }

    // Ensure amount is a number
    const amount = Number(payment.paidAmount);
    if (isNaN(amount)) {
      return res
        .status(400)
        .json({ message: "Invalid payment amount in record" });
    }

    // Prevent OFFICE_ADMIN from changing payment status to COLLECTED (accountant/super admin only)
    // Prioritize jobTitle over role
    const userRole = req.user?.jobTitle || req.user?.role;
    if (userRole === "OFFICE_ADMIN" && paymentStatus === "COLLECTED") {
      return res.status(403).json({
        message: "OFFICE_ADMIN cannot change payment status to COLLECTED. Contact an Accountant or Super Admin.",
      });
    }
    // Validate paymentStatus is one of the allowed values
    const validStatuses = ["PENDING", "COLLECTED", "REJECTED", "BANK_VERIFIED"];
    if (!validStatuses.includes(paymentStatus)) {
      return res.status(400).json({ message: "Invalid payment status." });
    }

    // Handle wallet payment status changes (PRIORITY: Wallet payments take precedence)
    if (payment.isWalletPayment) {
      console.log('Processing wallet payment status change');
      console.log('Current status:', payment.paymentStatus, 'New status:', paymentStatus);
      console.log('Order is dealer order:', order.dealerOrder);
      console.log('Payment is wallet payment:', payment.isWalletPayment);
      console.log('Order dealer field:', order.dealer);
      console.log('Order sales person field:', order.salesPerson);
      
      // Determine the dealer for wallet operations
      let dealerForWallet = null;
      
      if (order.dealer) {
        // Use the order's dealer field if available
        dealerForWallet = order.dealer;
        console.log('Using order dealer for wallet operations:', dealerForWallet);
      } else if (order.salesPerson) {
        // Check if sales person is a dealer
        const salesPerson = await User.findById(order.salesPerson);
        if (salesPerson && salesPerson.jobTitle === 'DEALER') {
          dealerForWallet = order.salesPerson;
          console.log('Using sales person as dealer for wallet operations:', dealerForWallet);
        }
      }
      
      if (!dealerForWallet) {
        console.warn('Payment marked as wallet payment but no dealer found. Skipping wallet operations.');
        console.log('This may indicate a data inconsistency. Payment will be updated without wallet operations.');
        // Continue with payment status update but skip wallet operations
      } else {
      
      // For wallet payments:
      // - When payment is rejected, credit back to wallet (add money)
      // - When payment is pending or collected, debit from wallet (subtract money)
      // - Since we now deduct on PENDING, we need to handle status changes carefully
      
      try {
        if (payment.paymentStatus === "COLLECTED" && paymentStatus === "REJECTED") {
          // Collected payment was rejected, credit back to wallet
          await updateDealerWalletBalance(dealerForWallet, amount, `Payment rejected - credited back to wallet for Order #${order._id}`, req.user?._id);
        } else if (payment.paymentStatus === "COLLECTED" && paymentStatus === "PENDING") {
          // Collected payment is now pending, but since we deduct on pending too, no change needed
          // Just update the description in transaction history
          console.log("Payment status changed from COLLECTED to PENDING - no wallet impact (both deduct from wallet)");
        } else if (payment.paymentStatus === "COLLECTED" && paymentStatus === "BANK_VERIFIED") {
          console.log("Payment status changed from COLLECTED to BANK_VERIFIED - no wallet impact");
        } else if (payment.paymentStatus === "REJECTED" && paymentStatus === "COLLECTED") {
          // Rejected payment is now collected, debit from wallet
          await updateDealerWalletBalance(dealerForWallet, -amount, `Payment collected - debited from wallet for Order #${order._id}`, req.user?._id);
        } else if (payment.paymentStatus === "REJECTED" && paymentStatus === "PENDING") {
          // Rejected payment is now pending, debit from wallet
          await updateDealerWalletBalance(dealerForWallet, -amount, `Payment pending - debited from wallet for Order #${order._id}`, req.user?._id);
        } else if (payment.paymentStatus === "REJECTED" && paymentStatus === "BANK_VERIFIED") {
          await updateDealerWalletBalance(dealerForWallet, -amount, `Payment bank verified - debited from wallet for Order #${order._id}`, req.user?._id);
        } else if (payment.paymentStatus === "PENDING" && paymentStatus === "COLLECTED") {
          // Pending payment is now collected, but since we deduct on both, no change needed
          console.log("Payment status changed from PENDING to COLLECTED - no wallet impact (both deduct from wallet)");
        } else if (payment.paymentStatus === "PENDING" && paymentStatus === "REJECTED") {
          // Pending payment is now rejected, credit back to wallet
          await updateDealerWalletBalance(dealerForWallet, amount, `Payment rejected - credited back to wallet for Order #${order._id}`, req.user?._id);
        } else if (payment.paymentStatus === "BANK_VERIFIED" && paymentStatus === "REJECTED") {
          await updateDealerWalletBalance(dealerForWallet, amount, `Payment rejected - credited back to wallet for Order #${order._id}`, req.user?._id);
        }
        // PENDING <-> BANK_VERIFIED: no wallet change (both represent "not yet collected")
      } catch (walletError) {
        console.error('Error updating dealer wallet:', walletError);
        return res.status(500).json({
          success: false,
          message: "Error updating dealer wallet",
          error: walletError.message,
        });
      }
      } // Close the else block for dealer validation
    }
    // Non-wallet collected payments do not change dealer wallet cash (ledger outstanding only).

    const previousPaymentStatus = payment.paymentStatus;
    if (previousPaymentStatus === paymentStatus) {
      if (paymentStatus === "COLLECTED") {
        maybeScheduleAcceptedWhatsAppAfterCollect(order);
      }
      return res.status(200).json({
        success: true,
        message: "Payment status unchanged.",
        order,
      });
    }
    payment.paymentStatus = paymentStatus;
    applyPaymentTimingToPayment(payment, order, { force: true });
    await order.save();

    if (shouldLogFarmerPlantLedger(order)) {
      try {
        const action = getFarmerPlantPaymentTransitionAction(
          previousPaymentStatus,
          paymentStatus
        );
        const transitionNeedsAmount = action === "CREDIT" || action === "REVERSAL";
        debugLog("H1", "order.controller.js:updatePaymentStatus", "Farmer ledger transition decision", {
          orderId: order.orderId,
          orderMongoId: String(order._id || ""),
          paymentId: String(payment._id || ""),
          previousPaymentStatus,
          newPaymentStatus: paymentStatus,
          action,
          transitionNeedsAmount,
          paidAmount: Number(payment.paidAmount || 0),
          paymentDate: payment.paymentDate || null,
        });
        if (action === "INVALID") {
          return res.status(400).json({
            success: false,
            message: "Invalid payment status transition.",
          });
        }
        if (transitionNeedsAmount && !(Number(payment.paidAmount) > 0)) {
          return res.status(400).json({
            success: false,
            message:
              "Cannot create farmer ledger entry: payment amount must be greater than 0 for this status transition.",
          });
        }

        await ensureFarmerPlantOrderDebit(order, { userId: req.user?._id });
        const ledgerTransition = await recordFarmerPlantLedgerPaymentTransition(
          order,
          payment,
          previousPaymentStatus,
          paymentStatus,
          { userId: req.user?._id }
        );
        debugLog("H1", "order.controller.js:updatePaymentStatus", "Farmer ledger transition result", {
          orderId: order.orderId,
          paymentId: String(payment._id || ""),
          action,
          transitionNeedsAmount,
          ledgerTransitionCreated: Boolean(ledgerTransition),
          ledgerTransitionRefType: ledgerTransition?.refType || null,
          ledgerOutstandingBefore: ledgerTransition?.outstandingBefore ?? null,
          ledgerOutstandingAfter: ledgerTransition?.outstandingAfter ?? null,
        });
        if (transitionNeedsAmount && !ledgerTransition) {
          return res.status(409).json({
            success: false,
            message:
              "Payment status updated but farmer ledger transition was not recorded (duplicate or invalid transition).",
          });
        }
      } catch (farmerLedgerErr) {
        console.error("Farmer plant ledger (payment status):", farmerLedgerErr);
      }
    }

    try {
      await syncDealerLedgerForOrder(order, { userId: req.user?._id });
    } catch (dealerLedgerErr) {
      console.error("Dealer ledger sync (payment status):", dealerLedgerErr);
    }

    // Send push notification based on payment status change
    try {
      let userToNotify = null;
      
      // Determine who to notify based on order type
      if (order.dealer) {
        // For dealer orders, notify the dealer
        userToNotify = await User.findById(order.dealer);
        console.log(`📱 Dealer order detected. Dealer ID: ${order.dealer}`);
      } else if (order.salesPerson) {
        // For farmer orders, notify the sales person
        userToNotify = await User.findById(order.salesPerson);
        console.log(`📱 Farmer order detected. Sales Person ID: ${order.salesPerson}`);
      }

      console.log(`📱 User to notify:`, {
        name: userToNotify?.name,
        phone: userToNotify?.phoneNumber,
        hasPushToken: !!userToNotify?.expoPushToken,
        pushToken: userToNotify?.expoPushToken ? `${userToNotify.expoPushToken.substring(0, 30)}...` : 'NONE'
      });

      if (userToNotify && userToNotify.expoPushToken) {
        const orderId = order.orderId || order._id;
        const pushToken = userToNotify.expoPushToken;

        console.log(`📤 Sending ${paymentStatus} notification for Order #${orderId}, Amount: ₹${amount}`);

        // Send notification based on new payment status
        if (paymentStatus === 'COLLECTED') {
          const result = await sendPaymentCollectedNotification(pushToken, orderId, amount);
          console.log(`✅ Payment collected notification sent for Order #${orderId}`, result);
        } else if (paymentStatus === 'REJECTED') {
          const result = await sendPaymentRejectedNotification(pushToken, orderId, amount, remark || '');
          console.log(`❌ Payment rejected notification sent for Order #${orderId}`, result);
        } else if (paymentStatus === 'PENDING') {
          const result = await sendPaymentPendingNotification(pushToken, orderId, amount);
          console.log(`⏳ Payment pending notification sent for Order #${orderId}`, result);
        }
      } else {
        console.log('⚠️ No push token found for user, skipping notification');
        console.log('   User needs to open the mobile app to register for notifications');
      }
    } catch (notificationError) {
      // Don't fail the request if notification fails
      console.error('❌ Error sending push notification:', notificationError);
      console.error('   Stack:', notificationError.stack);
    }

    if (paymentStatus === "COLLECTED") {
      maybeScheduleAcceptedWhatsAppAfterCollect(order);
    }

    return res.status(200).json({
      success: true,
      message: "Payment status updated successfully.",
      order,
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({
      success: false,
      message: "An error occurred while updating the payment status.",
      error: error.message,
    });
  }
};

const addAfterDispatchedOrderIds = catchAsync(async (req, res, next) => {
  const { dispatchId } = req.params;
  const { orderIds } = req.body;

  try {
    // Find the dispatch by ID
    const dispatch = await Dispatch.findById(dispatchId);

    if (!dispatch) {
      return res.status(404).json({
        status: "fail",
        message: "Dispatch not found",
      });
    }

    // Initialize afterDispatchedOrderIds array if it doesn't exist
    if (!dispatch.afterDispatchedOrderIds) {
      dispatch.afterDispatchedOrderIds = [];
    }

    // Add the new order IDs to the afterDispatchedOrderIds array
    dispatch.afterDispatchedOrderIds = [
      ...dispatch.afterDispatchedOrderIds,
      ...orderIds,
    ];

    // Save the updated dispatch
    await dispatch.save();

    return res.status(200).json({
      status: "success",
      message: "After dispatched order IDs added successfully",
      data: {
        dispatch,
      },
    });
  } catch (error) {
    console.error("Error adding after dispatched order IDs:", error);
    return res.status(500).json({
      status: "error",
      message: "An error occurred while adding after dispatched order IDs.",
      error: error.message,
    });
  }
});

// Get orders by specific status
const getOrdersByStatus = catchAsync(async (req, res, next) => {
  const { status, startDate, endDate, page = 1, limit = 100, search } = req.query;
  
  try {
    const order = -1; // desc order
    const skip = (page - 1) * limit;

    // Build the aggregation pipeline
    const pipeline = [];

    // Status filter
    if (status) {
      const statusArray = status.split(",").map((s) => s.trim());
      pipeline.push({
        $match: {
          orderStatus: { $in: statusArray },
        },
      });
    }

    // Date range filtering
    if (startDate && endDate) {
      const parseDate = (dateStr, isEnd = false) => {
        const [day, month, year] = dateStr.split("-");
        return isEnd
          ? new Date(`${year}-${month}-${day}T23:59:59.999Z`)
          : new Date(`${year}-${month}-${day}T00:00:00.000Z`);
      };

      const start = parseDate(startDate);
      const end = parseDate(endDate, true);
      pipeline.push({ $match: { orderBookingDate: { $gte: start, $lte: end } } });
    }

    // Search filtering
    if (search) {
      const searchTrimmed = String(search).trim();
      const searchRegex = new RegExp(searchTrimmed, "i");

      pipeline.push({
        $lookup: {
          from: "farmers",
          localField: "farmer",
          foreignField: "_id",
          as: "farmer",
        },
      });

      pipeline.push({
        $addFields: {
          "farmer.mobileNumberStr": {
            $toString: { $arrayElemAt: ["$farmer.mobileNumber", 0] },
          },
          orderForMobileStr: {
            $let: {
              vars: { raw: "$orderFor.mobileNumber" },
              in: {
                $cond: [
                  {
                    $or: [
                      { $eq: ["$$raw", null] },
                      { $eq: ["$$raw", ""] },
                      { $eq: ["$$raw", 0] },
                    ],
                  },
                  "",
                  { $toString: "$$raw" },
                ],
              },
            },
          },
        },
      });

      const isNumeric = /^\d+$/.test(searchTrimmed);
      const searchAsNumber = isNumeric ? Number(searchTrimmed) : NaN;

      const searchOr = [
        { orderId: isNumeric ? searchAsNumber : search },
        { "farmer.name": searchRegex },
        { "farmer.mobileNumberStr": searchRegex },
        { "orderFor.name": searchRegex },
        { "orderFor.village": searchRegex },
        { "orderFor.talukaName": searchRegex },
        { "orderFor.districtName": searchRegex },
        { "orderFor.district": searchRegex },
      ];
      if (isNumeric && searchTrimmed.length >= 10) {
        searchOr.push({ orderForMobileStr: searchTrimmed });
      }

      pipeline.push({
        $match: {
          $or: searchOr,
        },
      });
    } else {
      pipeline.push({
        $lookup: {
          from: "farmers",
          localField: "farmer",
          foreignField: "_id",
          as: "farmer",
        },
      });
    }

    // Common lookups
    pipeline.push(
      {
        $lookup: {
          from: "plantcms",
          localField: "plantName",
          foreignField: "_id",
          as: "plantName",
        },
      },
      {
        $lookup: {
          from: "users",
          localField: "salesPerson",
          foreignField: "_id",
          as: "salesPerson",
        },
      },
      {
        $lookup: {
          from: "trays",
          localField: "cavity",
          foreignField: "_id",
          as: "cavityDetails",
        },
      },
      {
        $lookup: {
          from: "users",
          localField: "statusChanges.changedBy",
          foreignField: "_id",
          as: "statusChangeUsers",
        },
      },
      {
        $lookup: {
          from: "users",
          localField: "dispatchHistory.processedBy",
          foreignField: "_id",
          as: "dispatchHistoryUsers",
        },
      },
      {
        $lookup: {
          from: "dispatches",
          localField: "dispatchHistory.dispatchId",
          foreignField: "_id",
          as: "dispatchHistoryDispatches",
        },
      }
    );

    // Standard booking slot lookup
    pipeline.push({
      $lookup: {
        from: "plantslots",
        let: { bookingSlotId: "$bookingSlot" },
        pipeline: [
          { $unwind: "$subtypeSlots" },
          { $unwind: "$subtypeSlots.slots" },
          {
            $match: {
              $expr: {
                $eq: [
                  { $toString: "$subtypeSlots.slots._id" },
                  { $toString: "$$bookingSlotId" },
                ],
              },
            },
          },
          {
            $project: {
              _id: 0,
              slotId: "$subtypeSlots.slots._id",
              startDay: "$subtypeSlots.slots.startDay",
              endDay: "$subtypeSlots.slots.endDay",
              subtypeId: "$subtypeSlots.subtypeId",
              month: "$subtypeSlots.slots.month",
            },
          },
        ],
        as: "bookingSlotDetails",
      },
    });

    // Enrich plantSubtype details
    pipeline.push({
      $set: {
        plantSubtypeDetails: {
          $arrayElemAt: [
            {
              $filter: {
                input: { $arrayElemAt: ["$plantName.subtypes", 0] },
                as: "subtype",
                cond: { $eq: ["$$subtype._id", "$plantSubtype"] },
              },
            },
            0,
          ],
        },
      },
    });



    // Project required fields
    pipeline.push(
      {
        $project: {
          farmer: {
            $arrayElemAt: [
              {
                $map: {
                  input: "$farmer",
                  as: "farmerData",
                  in: {
                    name: "$$farmerData.name",
                    mobileNumber: "$$farmerData.mobileNumber",
                    village: "$$farmerData.village",
                    taluka: "$$farmerData.taluka",
                    district: "$$farmerData.district",
                    state: "$$farmerData.state",
                    stateName: "$$farmerData.stateName",
                    districtName: "$$farmerData.districtName",
                    talukaName: "$$farmerData.talukaName",
                  },
                },
              },
              0,
            ],
          },
          plantType: {
            id: { $arrayElemAt: ["$plantName._id", 0] },
            name: { $arrayElemAt: ["$plantName.name", 0] },
          },
          plantSubtype: {
            id: "$plantSubtypeDetails._id",
            name: "$plantSubtypeDetails.name",
          },
          cavity: {
            $let: {
              vars: {
                trayId: {
                  $ifNull: [
                    { $arrayElemAt: ["$cavityDetails._id", 0] },
                    "$cavity",
                  ],
                },
              },
              in: {
                $cond: {
                  if: { $eq: ["$$trayId", null] },
                  then: null,
                  else: {
                    id: "$$trayId",
                    name: { $arrayElemAt: ["$cavityDetails.name", 0] },
                    cavity: { $arrayElemAt: ["$cavityDetails.cavity", 0] },
                    numberPerCrate: {
                      $arrayElemAt: ["$cavityDetails.numberPerCrate", 0],
                    },
                  },
                },
              },
            },
          },
          bookingSlot: "$bookingSlotDetails",
          salesPerson: {
            $arrayElemAt: [
              {
                $map: {
                  input: "$salesPerson",
                  as: "sales",
                  in: {
                    name: "$$sales.name",
                    phoneNumber: "$$sales.phoneNumber",
                  },
                },
              },
              0,
            ],
          },
          createdAt: 1,
          orderStatus: 1,
          payment: 1,
          numberOfPlants: 1,
          remainingPlants: 1,
          returnedPlants: 1,
          damagedPlants: { $ifNull: ["$damagedPlants", 0] },
          totalPlants: {
            $ifNull: [
              "$totalPlants",
              {
                $add: [
                  { $ifNull: ["$numberOfPlants", 0] },
                  { $ifNull: ["$additionalPlants", 0] }
                ]
              }
            ]
          },
          returnReason: 1,
          returnHistory: 1,
          dispatchHistory: 1,
          deliveryChallanInvoiceNumber: 1,
          officialDeliveryChallanNumber: 1,
          orderId: 1,
          rate: 1,
          farmReadyDate: 1,
          orderBookingDate: 1,
          orderPaymentStatus: 1,
          paymentCompleted: 1,
          dealerOrder: 1,
          notes: 1,
          orderRemarks: 1,
          statusChanges: {
            $map: {
              input: "$statusChanges",
              as: "change",
              in: {
                previousStatus: "$$change.previousStatus",
                newStatus: "$$change.newStatus",
                reason: "$$change.reason",
                notes: "$$change.notes",
                changedAt: "$$change.createdAt",
                changedBy: {
                  $cond: {
                    if: "$$change.changedBy",
                    then: {
                      $let: {
                        vars: {
                          userId: { $toString: "$$change.changedBy" }
                        },
                        in: {
                          $let: {
                            vars: {
                              userData: {
                                $arrayElemAt: [
                                  {
                                    $filter: {
                                      input: "$statusChangeUsers",
                                      as: "user",
                                      cond: { $eq: [{ $toString: "$$user._id" }, "$$userId"] }
                                    }
                                  },
                                  0
                                ]
                              }
                            },
                            in: {
                              $ifNull: [
                                {
                                  _id: "$$userData._id",
                                  name: "$$userData.name",
                                  phoneNumber: "$$userData.phoneNumber"
                                },
                                { _id: "$$change.changedBy" }
                              ]
                            }
                          }
                        }
                      }
                    },
                    else: null,
                  },
                },
              },
            },
          },
          deliveryChanges: {
            $map: {
              input: "$deliveryChanges",
              as: "change",
              in: {
                previousDeliveryDate: "$$change.previousDeliveryDate",
                newDeliveryDate: "$$change.newDeliveryDate",
                reasonForChange: "$$change.reasonForChange",
                changedAt: "$$change.createdAt",
              },
            },
          },
          dispatchHistory: {
            $map: {
              input: { $ifNull: ["$dispatchHistory", []] },
              as: "dispatchEntry",
              in: {
                date: "$$dispatchEntry.date",
                quantity: "$$dispatchEntry.quantity",
                remainingAfterDispatch: "$$dispatchEntry.remainingAfterDispatch",
                dispatchId: "$$dispatchEntry.dispatchId",
                dispatch: {
                  $let: {
                    vars: {
                      dispatchIdStr: { $toString: "$$dispatchEntry.dispatchId" }
                    },
                    in: {
                      $arrayElemAt: [
                        {
                          $filter: {
                            input: "$dispatchHistoryDispatches",
                            as: "dispatch",
                            cond: { $eq: [{ $toString: "$$dispatch._id" }, "$$dispatchIdStr"] }
                          }
                        },
                        0
                      ]
                    }
                  }
                },
                processedBy: {
                  $cond: {
                    if: "$$dispatchEntry.processedBy",
                    then: {
                      $let: {
                        vars: {
                          userId: { $toString: "$$dispatchEntry.processedBy" }
                        },
                        in: {
                          $let: {
                            vars: {
                              userData: {
                                $arrayElemAt: [
                                  {
                                    $filter: {
                                      input: "$dispatchHistoryUsers",
                                      as: "user",
                                      cond: { $eq: [{ $toString: "$$user._id" }, "$$userId"] }
                                    }
                                  },
                                  0
                                ]
                              }
                            },
                            in: {
                              $ifNull: [
                                {
                                  _id: "$$userData._id",
                                  name: "$$userData.name",
                                  phoneNumber: "$$userData.phoneNumber"
                                },
                                { _id: "$$dispatchEntry.processedBy" }
                              ]
                            }
                          }
                        }
                      }
                    },
                    else: null,
                  },
                },
              },
            },
          },
          publicOrderCode: 1,
          whatsappAcceptedSentAt: 1,
          whatsappDispatchSentAt: 1,
          whatsappAcceptedMessageKey: 1,
          whatsappDispatchMessageKey: 1,
          deliveryDate: 1,
          additionalPlants: { $ifNull: ["$additionalPlants", 0] },
          dispatchDayKey: 1,
          dispatchTargetDate: 1,
          // Add orderFor field if present
          orderFor: 1,
        },
      },
      { $sort: { createdAt: order } },
      { $skip: skip },
      { $limit: parseInt(limit, 10) }
    );

    // Execute the pipeline
    const results = await Order.aggregate(pipeline);

    // Transform documents for response
    const transformedResults = results.map((item) => {
      const { _id, ...rest } = item;
      return { id: _id, _id, ...rest };
    });

    const response = generateResponse(
      "Success",
      `Orders with status ${status} found successfully`,
      transformedResults,
      undefined
    );

    return res.status(200).json(response);
  } catch (error) {
    console.error("Error fetching orders by status:", error);
    return res.status(500).json({ 
      message: "An error occurred while fetching orders.", 
      error: error.message 
    });
  }
});

// Get all payments with date filtering
const getAllPayments = catchAsync(async (req, res, next) => {
  const {
    startDate,
    endDate,
    paymentStatus: paymentStatusParam,
    paymentTiming: paymentTimingParam,
    pendingAdvanceOnly,
    page = 1,
    limit = 100,
    search,
  } = req.query;

  let paymentStatus = paymentStatusParam;
  let paymentTiming = paymentTimingParam;
  if (String(pendingAdvanceOnly).toLowerCase() === "true") {
    paymentTiming = paymentTiming || "advance";
    paymentStatus = paymentStatus || "PENDING";
  }
  
  try {
    const order = -1; // desc order
    const skip = (page - 1) * limit;

    // Build the aggregation pipeline
    const pipeline = [];

    /** Plants billed after return + damage (same as order payment gross). */
    const billablePlantsExpr = {
      $max: [
        0,
        {
          $subtract: [
            {
              $ifNull: [
                "$totalPlants",
                {
                  $add: [
                    { $ifNull: ["$numberOfPlants", 0] },
                    { $ifNull: ["$additionalPlants", 0] },
                  ],
                },
              ],
            },
            {
              $add: [
                { $ifNull: ["$returnedPlants", 0] },
                { $ifNull: ["$damagedPlants", 0] },
              ],
            },
          ],
        },
      ],
    };

    // Before $unwind: billable qty/amount + sum of COLLECTED payments on the order (for correct balance per row)
    pipeline.push({
      $addFields: {
        _billablePlantsForPayment: billablePlantsExpr,
        _totalCollectedPayments: {
          $reduce: {
            input: { $ifNull: ["$payment", []] },
            initialValue: 0,
            in: {
              $add: [
                "$$value",
                {
                  $cond: [
                    { $eq: ["$$this.paymentStatus", "COLLECTED"] },
                    { $toDouble: { $ifNull: ["$$this.paidAmount", 0] } },
                    0,
                  ],
                },
              ],
            },
          },
        },
      },
    });
    pipeline.push({
      $addFields: {
        _billableOrderAmount: {
          $multiply: [
            { $toDouble: { $ifNull: ["$rate", 0] } },
            "$_billablePlantsForPayment",
          ],
        },
      },
    });

    // Unwind payments to work with individual payment records
    pipeline.push({
      $unwind: {
        path: "$payment",
        preserveNullAndEmptyArrays: false
      }
    });

    // Payment status filter
    if (paymentStatus) {
      const statusArray = paymentStatus.split(",").map((s) => s.trim());
      pipeline.push({
        $match: {
          "payment.paymentStatus": { $in: statusArray },
        },
      });
    }

    if (paymentTiming) {
      const timingArray = paymentTiming
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter((s) => s === "advance" || s === "balance");
      if (timingArray.length) {
        pipeline.push({
          $match: {
            "payment.paymentTiming": { $in: timingArray },
          },
        });
      }
    }

    // Date range filtering for payment date
    if (startDate && endDate) {
      try {
        const parseDate = (dateStr, isEnd = false) => {
          const [day, month, year] = dateStr.split("-");
          return isEnd
            ? new Date(`${year}-${month}-${day}T23:59:59.999Z`)
            : new Date(`${year}-${month}-${day}T00:00:00.000Z`);
        };

        const start = parseDate(startDate);
        const end = parseDate(endDate, true);
        
        // Only add date filter if dates are valid
        if (!isNaN(start.getTime()) && !isNaN(end.getTime())) {
          pipeline.push({ 
            $match: { 
              "payment.paymentDate": { $gte: start, $lte: end } 
            } 
          });
        }
      } catch (dateError) {
        console.error("Date parsing error:", dateError);
        // Continue without date filter if parsing fails
      }
    }

    // Search filtering
    if (search) {
      const searchTrimmed = String(search).trim();
      const searchRegex = new RegExp(searchTrimmed, "i");

      pipeline.push({
        $lookup: {
          from: "farmers",
          localField: "farmer",
          foreignField: "_id",
          as: "farmer",
        },
      });

      pipeline.push({
        $addFields: {
          "farmer.mobileNumberStr": {
            $toString: { $arrayElemAt: ["$farmer.mobileNumber", 0] },
          },
          orderForMobileStr: {
            $let: {
              vars: { raw: "$orderFor.mobileNumber" },
              in: {
                $cond: [
                  {
                    $or: [
                      { $eq: ["$$raw", null] },
                      { $eq: ["$$raw", ""] },
                      { $eq: ["$$raw", 0] },
                    ],
                  },
                  "",
                  { $toString: "$$raw" },
                ],
              },
            },
          },
        },
      });

      const isNumeric = /^\d+$/.test(searchTrimmed);
      const searchAsNumber = isNumeric ? Number(searchTrimmed) : NaN;

      const searchOr = [
        { orderId: isNumeric ? searchAsNumber : search },
        { "farmer.name": searchRegex },
        { "farmer.mobileNumberStr": searchRegex },
        { "orderFor.name": searchRegex },
        { "orderFor.village": searchRegex },
        { "orderFor.talukaName": searchRegex },
        { "orderFor.districtName": searchRegex },
        { "orderFor.district": searchRegex },
      ];
      if (isNumeric && searchTrimmed.length >= 10) {
        searchOr.push({ orderForMobileStr: searchTrimmed });
      }

      pipeline.push({
        $match: {
          $or: searchOr,
        },
      });
    } else {
      pipeline.push({
        $lookup: {
          from: "farmers",
          localField: "farmer",
          foreignField: "_id",
          as: "farmer",
        },
      });
    }

    // Common lookups
    pipeline.push(
      {
        $lookup: {
          from: "plantcms",
          localField: "plantName",
          foreignField: "_id",
          as: "plantName",
        },
      },
      {
        $lookup: {
          from: "users",
          localField: "salesPerson",
          foreignField: "_id",
          as: "salesPerson",
        },
      }
    );

    // Lookup current dispatch for vehicle/driver details
    pipeline.push({
      $lookup: {
        from: "dispatches",
        localField: "currentDispatchId",
        foreignField: "_id",
        as: "_dispatch",
      },
    });

    // Project payment-focused fields
    pipeline.push({
      $project: {
        orderId: 1,
        orderStatus: 1,
        orderPaymentStatus: 1,
        numberOfPlants: 1,
        additionalPlants: { $ifNull: ["$additionalPlants", 0] },
        returnedPlants: { $ifNull: ["$returnedPlants", 0] },
        damagedPlants: { $ifNull: ["$damagedPlants", 0] },
        rate: 1,
        billablePlants: "$_billablePlantsForPayment",
        totalOrderAmount: "$_billableOrderAmount",
        totalCollectedOnOrder: "$_totalCollectedPayments",
        orderOutstandingBalance: {
          $subtract: ["$_billableOrderAmount", "$_totalCollectedPayments"],
        },
        farmer: {
          $arrayElemAt: [
            {
              $map: {
                input: "$farmer",
                as: "farmerData",
                in: {
                  name: "$$farmerData.name",
                  mobileNumber: "$$farmerData.mobileNumber",
                  village: "$$farmerData.village",
                  taluka: "$$farmerData.taluka",
                  district: "$$farmerData.district",
                },
              },
            },
            0,
          ],
        },
        plantType: {
          id: { $arrayElemAt: ["$plantName._id", 0] },
          name: { $arrayElemAt: ["$plantName.name", 0] },
        },
        salesPerson: {
          $arrayElemAt: [
            {
              $map: {
                input: "$salesPerson",
                as: "sales",
                in: {
                  name: "$$sales.name",
                  phoneNumber: "$$sales.phoneNumber",
                },
              },
            },
            0,
          ],
        },
        payment: 1,
        screenshots: 1,
        orderBookingDate: 1,
        createdAt: 1,
        updatedAt: 1,
        dealerOrder: 1,
        currentDispatchId: 1,
        dispatch: {
          vehicleName:   { $arrayElemAt: ["$_dispatch.vehicleName", 0] },
          vehicleNumber: { $arrayElemAt: ["$_dispatch.vehicleNumber", 0] },
          driverName:    { $arrayElemAt: ["$_dispatch.driverName", 0] },
          driverMobile:  { $arrayElemAt: ["$_dispatch.driverMobile", 0] },
        },
      },
    });

    // Keep most recently changed orders first so recent payment edits surface immediately.
    pipeline.push({ 
      $sort: { 
        "updatedAt": order,
        "payment.paymentDate": order,
        "createdAt": order 
      } 
    });
    pipeline.push({ $skip: skip });
    pipeline.push({ $limit: parseInt(limit, 10) });

    // Execute the pipeline with error handling
    let results;
    try {
      results = await Order.aggregate(pipeline);
    } catch (aggregateError) {
      console.error("Aggregation error:", aggregateError);
      return res.status(500).json({ 
        status: "error",
        message: "Database query failed", 
        error: aggregateError.message 
      });
    }

    // Transform documents for response
    const transformedResults = results.map((item) => {
      const { _id, ...rest } = item;
      return { id: _id, _id, ...rest };
    });

    const response = generateResponse(
      "Success",
      "Payments found successfully",
      transformedResults,
      undefined
    );

    return res.status(200).json(response);
  } catch (error) {
    console.error("Error fetching payments:", error);
    return res.status(500).json({ 
      status: "error",
      message: "An error occurred while fetching payments.", 
      error: error.message 
    });
  }
});

// Get unique villages from orders
const getUniqueVillages = catchAsync(async (req, res, next) => {
  try {
    const villages = await Order.aggregate([
      {
        $lookup: {
          from: "farmers",
          localField: "farmer",
          foreignField: "_id",
          as: "farmer",
        },
      },
      {
        $unwind: "$farmer",
      },
      {
        $group: {
          _id: "$farmer.village",
        },
      },
      {
        $match: {
          _id: { $ne: null, $ne: "" },
        },
      },
      {
        $sort: { _id: 1 },
      },
      {
        $project: {
          _id: 0,
          village: "$_id",
        },
      },
    ]);

    res.status(200).json({
      success: true,
      data: villages.map((v) => v.village),
    });
  } catch (error) {
    console.error("Error fetching unique villages:", error);
    res.status(500).json({
      success: false,
      message: "An error occurred while fetching villages.",
      error: error.message,
    });
  }
});

// Get unique districts from orders
const getUniqueDistricts = catchAsync(async (req, res, next) => {
  try {
    const districts = await Order.aggregate([
      {
        $lookup: {
          from: "farmers",
          localField: "farmer",
          foreignField: "_id",
          as: "farmer",
        },
      },
      {
        $unwind: "$farmer",
      },
      {
        $group: {
          _id: "$farmer.district",
        },
      },
      {
        $match: {
          _id: { $ne: null, $ne: "" },
        },
      },
      {
        $sort: { _id: 1 },
      },
      {
        $project: {
          _id: 0,
          district: "$_id",
        },
      },
    ]);

    res.status(200).json({
      success: true,
      data: districts.map((d) => d.district),
    });
  } catch (error) {
    console.error("Error fetching unique districts:", error);
    res.status(500).json({
      success: false,
      message: "An error occurred while fetching districts.",
      error: error.message,
    });
  }
});

// Get unique talukas from orders (talukaName preferred, else taluka)
const getUniqueTalukas = catchAsync(async (req, res, next) => {
  try {
    const talukas = await Order.aggregate([
      {
        $lookup: {
          from: "farmers",
          localField: "farmer",
          foreignField: "_id",
          as: "farmer",
        },
      },
      { $unwind: "$farmer" },
      {
        $addFields: {
          _talukaLabel: {
            $trim: {
              input: {
                $ifNull: [
                  "$farmer.talukaName",
                  { $ifNull: ["$farmer.taluka", ""] },
                ],
              },
            },
          },
        },
      },
      {
        $match: {
          _talukaLabel: { $nin: [null, ""] },
        },
      },
      { $group: { _id: "$_talukaLabel" } },
      { $sort: { _id: 1 } },
    ]);

    res.status(200).json({
      success: true,
      data: talukas.map((t) => t._id),
    });
  } catch (error) {
    console.error("Error fetching unique talukas:", error);
    res.status(500).json({
      success: false,
      message: "An error occurred while fetching talukas.",
      error: error.message,
    });
  }
});

/**
 * Get dealer wallet balance for a specific order
 * This is useful for frontend to display current wallet balance when adding payments
 */
const getDealerWalletBalanceForOrder = catchAsync(async (req, res, next) => {
  const { orderId } = req.params;

  try {
    // Find the order
    const order = await Order.findById(orderId);
    if (!order) {
      return res.status(404).json({ 
        success: false,
        message: "Order not found" 
      });
    }

    // Check if this is a dealer order
    if (!order.dealerOrder || !order.dealer) {
      return res.status(400).json({ 
        success: false,
        message: "This is not a dealer order" 
      });
    }

    // Get dealer information
    const dealer = await User.findById(order.dealer).select('name phoneNumber');
    if (!dealer) {
      return res.status(404).json({ 
        success: false,
        message: "Dealer not found" 
      });
    }

    // Get wallet information (resolve cash from tx chain / ledger — not raw availableAmount alone)
    const wallet = await DealerWallet.findOne({ dealer: order.dealer })
      .select("availableAmount transactions entries")
      .lean();
    const availableResolved = await resolveDealerCashBalance(order.dealer, wallet);

    // Calculate order total
    const orderTotal = order.numberOfPlants * order.rate;
    
    // Calculate total paid amount
    const totalPaid = order.payment
      .filter(p => p.paymentStatus === "COLLECTED")
      .reduce((sum, p) => sum + (p.paidAmount || 0), 0);
    
    // Calculate remaining amount
    const remainingAmount = orderTotal - totalPaid;

    const response = {
      success: true,
      message: "Dealer wallet balance retrieved successfully",
      data: {
        order: {
          orderId: order.orderId,
          orderTotal: orderTotal,
          totalPaid: totalPaid,
          remainingAmount: remainingAmount,
          numberOfPlants: order.numberOfPlants,
          rate: order.rate
        },
        dealer: {
          _id: dealer._id,
          name: dealer.name,
          phoneNumber: dealer.phoneNumber
        },
        wallet: wallet ? {
          _id: wallet._id,
          availableAmount: availableResolved,
          totalQuantity: wallet.entries ? wallet.entries.reduce((sum, entry) => sum + (entry.quantity || 0), 0) : 0,
          totalBookedQuantity: wallet.entries ? wallet.entries.reduce((sum, entry) => sum + (entry.bookedQuantity || 0), 0) : 0,
          totalRemainingQuantity: wallet.entries ? wallet.entries.reduce((sum, entry) => sum + (entry.remainingQuantity || 0), 0) : 0,
          transactionsCount: wallet.transactions ? wallet.transactions.length : 0
        } : {
          availableAmount: 0,
          totalQuantity: 0,
          totalBookedQuantity: 0,
          totalRemainingQuantity: 0,
          transactionsCount: 0
        }
      }
    };

    return res.status(200).json(response);
  } catch (error) {
    console.error("Error getting dealer wallet balance for order:", error);
    return res.status(500).json({
      success: false,
      message: "Error retrieving dealer wallet balance",
      error: error.message
    });
  }
});

// Get orders to be dispatched based on delivery date range
const getOrdersToBeDispatched = catchAsync(async (req, res, next) => {
  try {
    const { startDate, endDate } = req.query;
    
    // Validate date parameters
    if (!startDate || !endDate) {
      return res.status(400).json({
        success: false,
        message: "Start date and end date are required",
        data: null
      });
    }

    // Parse dates
    const start = new Date(startDate);
    start.setHours(0, 0, 0, 0); // Set to start of day
    
    const end = new Date(endDate);
    end.setHours(23, 59, 59, 999); // Set to end of day
    
    // Validate date format
    if (isNaN(start.getTime()) || isNaN(end.getTime())) {
      return res.status(400).json({
        success: false,
        message: "Invalid date format. Please use YYYY-MM-DD format",
        data: null
      });
    }

    // Find orders with delivery date within the date range
    const orders = await Order.aggregate([
      {
        $match: {
          deliveryDate: {
            $gte: start,
            $lte: end
          }
          // Removed status filter - now shows all statuses
        }
      },
      {
        $lookup: {
          from: "plantslots",
          localField: "bookingSlot",
          foreignField: "subtypeSlots._id",
          as: "slotData"
        }
      },
      {
        $unwind: {
          path: "$slotData",
          preserveNullAndEmptyArrays: true
        }
      },
      {
        $unwind: {
          path: "$slotData.subtypeSlots",
          preserveNullAndEmptyArrays: true
        }
      },
      {
        $lookup: {
          from: "farmers",
          localField: "farmer",
          foreignField: "_id",
          as: "farmerData"
        }
      },
      {
        $lookup: {
          from: "users",
          localField: "salesPerson",
          foreignField: "_id",
          as: "salesPersonData"
        }
      },
      {
        $lookup: {
          from: "plantcms",
          localField: "plantName",
          foreignField: "_id",
          as: "plantData"
        }
      },
      {
        $lookup: {
          from: "plantcms",
          localField: "plantSubtype",
          foreignField: "subtypes._id",
          as: "subtypeData"
        }
      },
      {
        $unwind: {
          path: "$farmerData",
          preserveNullAndEmptyArrays: true
        }
      },
      {
        $unwind: {
          path: "$salesPersonData",
          preserveNullAndEmptyArrays: true
        }
      },
      {
        $unwind: {
          path: "$plantData",
          preserveNullAndEmptyArrays: true
        }
      },
      {
        $unwind: {
          path: "$subtypeData",
          preserveNullAndEmptyArrays: true
        }
      },
      {
        $addFields: {
          matchedSubtype: {
            $arrayElemAt: [
              {
                $filter: {
                  input: { $ifNull: ["$subtypeData.subtypes", []] },
                  as: "subtype",
                  cond: { $eq: ["$$subtype._id", "$plantSubtype"] }
                }
              },
              0
            ]
          }
        }
      },
      {
        $project: {
          _id: 1,
          orderId: 1,
          numberOfPlants: 1,
          remainingPlants: 1,
          rate: 1,
          orderStatus: 1,
          orderPaymentStatus: 1,
          deliveryDate: 1,
          farmReadyDate: 1,
          createdAt: 1,
          updatedAt: 1,
          farmer: {
            _id: "$farmerData._id",
            name: "$farmerData.name",
            mobileNumber: "$farmerData.mobileNumber",
            village: "$farmerData.village",
            taluka: "$farmerData.taluka",
            district: "$farmerData.district",
            state: "$farmerData.state"
          },
          salesPerson: {
            _id: "$salesPersonData._id",
            name: "$salesPersonData.name",
            phoneNumber: "$salesPersonData.phoneNumber"
          },
          plantName: "$plantData.name",
          plantType: {
            _id: "$plantData._id",
            id: "$plantData._id",
            name: "$plantData.name"
          },
          plantSubtype: {
            _id: "$matchedSubtype._id",
            id: "$matchedSubtype._id", 
            name: "$matchedSubtype.name"
          },
          slotInfo: {
            startDay: "$slotData.subtypeSlots.startDay",
            endDay: "$slotData.subtypeSlots.endDay",
            month: "$slotData.subtypeSlots.month",
            totalPlants: "$slotData.subtypeSlots.totalPlants",
            totalBookedPlants: "$slotData.subtypeSlots.totalBookedPlants"
          },
          totalAmount: { $multiply: ["$numberOfPlants", "$rate"] }
        }
      },
      {
        $sort: { createdAt: -1 }
      }
    ]);

    return res.status(200).json({
      success: true,
      message: "Orders to be dispatched retrieved successfully",
      data: {
        orders,
        totalCount: orders.length,
        dateRange: {
          startDate,
          endDate
        }
      }
    });

  } catch (error) {
    console.error("Error getting orders to be dispatched:", error);
    return res.status(500).json({
      success: false,
      message: "Error retrieving orders to be dispatched",
      error: error.message
    });
  }
});

// Get all cavities from all orders
const getAllCavitiesFromOrders = catchAsync(async (req, res, next) => {
  try {
    // Aggregate to get all unique cavity IDs from orders
    const cavitiesFromOrders = await Order.aggregate([
      {
        $match: {
          cavity: { $exists: true, $ne: null }
        }
      },
      {
        $group: {
          _id: "$cavity",
          orderCount: { $sum: 1 },
          totalPlants: { $sum: "$numberOfPlants" }
        }
      },
      {
        $lookup: {
          from: "trays",
          localField: "_id",
          foreignField: "_id",
          as: "trayDetails"
        }
      },
      {
        $unwind: {
          path: "$trayDetails",
          preserveNullAndEmptyArrays: true
        }
      },
      {
        $project: {
          _id: 0,
          cavityId: "$_id",
          cavityNumber: "$trayDetails.cavity",
          cavityName: "$trayDetails.name",
          numberPerCrate: "$trayDetails.numberPerCrate",
          isActive: "$trayDetails.isActive",
          orderCount: 1,
          totalPlants: 1
        }
      },
      {
        $sort: { cavityNumber: 1 }
      }
    ]);

    return res.status(200).json({
      success: true,
      data: {
        cavities: cavitiesFromOrders,
        totalCavities: cavitiesFromOrders.length,
        summary: {
          totalOrders: cavitiesFromOrders.reduce((sum, c) => sum + c.orderCount, 0),
          totalPlants: cavitiesFromOrders.reduce((sum, c) => sum + c.totalPlants, 0)
        }
      }
    });
  } catch (error) {
    console.error("Error fetching cavities from orders:", error);
    return res.status(500).json({
      success: false,
      message: "An error occurred while fetching cavities.",
      error: error.message
    });
  }
});

// Order Bucketing - Hierarchical grouping of orders
const getOrderBucketing = catchAsync(async (req, res, next) => {
  try {
    const { level, startDate, endDate, status, plantId, subtypeId, year, month, day } = req.query;

    // Validate level parameter
    const levelNum = parseInt(level);
    if (!levelNum || levelNum < 1 || levelNum > 5) {
      return res.status(400).json({
        success: false,
        message: "Level must be between 1 and 5"
      });
    }

    // Build match filter
    const matchFilter = {};

    // Date filter
    if (startDate || endDate) {
      matchFilter.orderBookingDate = {};
      if (startDate) {
        matchFilter.orderBookingDate.$gte = new Date(startDate);
      }
      if (endDate) {
        matchFilter.orderBookingDate.$lte = new Date(endDate);
      }
    }

    // Status filter
    if (status) {
      matchFilter.orderStatus = status;
    }

    // Plant filter
    if (plantId) {
      matchFilter.plantName = new mongoose.Types.ObjectId(plantId);
    }

    // Subtype filter
    if (subtypeId) {
      matchFilter.plantSubtype = new mongoose.Types.ObjectId(subtypeId);
    }

    // Year filter
    if (year) {
      const yearNum = parseInt(year);
      matchFilter.orderBookingDate = matchFilter.orderBookingDate || {};
      matchFilter.orderBookingDate.$gte = new Date(`${yearNum}-01-01`);
      matchFilter.orderBookingDate.$lte = new Date(`${yearNum}-12-31T23:59:59.999Z`);
    }

    // Month filter
    if (month && year) {
      const yearNum = parseInt(year);
      const monthNum = parseInt(month);
      matchFilter.orderBookingDate = matchFilter.orderBookingDate || {};
      matchFilter.orderBookingDate.$gte = new Date(yearNum, monthNum - 1, 1);
      matchFilter.orderBookingDate.$lte = new Date(yearNum, monthNum, 0, 23, 59, 59, 999);
    }

    // Day filter
    if (day && month && year) {
      const yearNum = parseInt(year);
      const monthNum = parseInt(month);
      const dayNum = parseInt(day);
      matchFilter.orderBookingDate = matchFilter.orderBookingDate || {};
      matchFilter.orderBookingDate.$gte = new Date(yearNum, monthNum - 1, dayNum);
      matchFilter.orderBookingDate.$lte = new Date(yearNum, monthNum - 1, dayNum, 23, 59, 59, 999);
    }

    let pipeline = [{ $match: matchFilter }];

    // Add lookup for plant information
    pipeline.push({
      $lookup: {
        from: "plantcms",
        localField: "plantName",
        foreignField: "_id",
        as: "plantDetails"
      }
    });

    // Add lookup for subtype information
    pipeline.push({
      $lookup: {
        from: "plantcms",
        let: { plantId: "$plantName", subtypeId: "$plantSubtype" },
        pipeline: [
          { $match: { $expr: { $eq: ["$_id", "$$plantId"] } } },
          { $unwind: "$subtypes" },
          { $match: { $expr: { $eq: ["$subtypes._id", "$$subtypeId"] } } },
          { $project: { subtypeName: "$subtypes.name" } }
        ],
        as: "subtypeDetails"
      }
    });

    // Group by level
    const groupStage = {
      totalOrders: { $sum: 1 },
      totalPlants: { $sum: "$numberOfPlants" },
      totalAmount: { $sum: { $multiply: ["$numberOfPlants", "$rate"] } },
      plantId: { $first: "$plantName" },
      plantName: { $first: { $arrayElemAt: ["$plantDetails.name", 0] } }
    };

    // Level 1: Group by plant
    if (levelNum === 1) {
      groupStage._id = "$plantName";
    }
    // Level 2: Group by plant + subtype
    else if (levelNum === 2) {
      groupStage._id = {
        plantId: "$plantName",
        subtypeId: "$plantSubtype"
      };
      groupStage.subtypeId = { $first: "$plantSubtype" };
      groupStage.subtypeName = { $first: { $arrayElemAt: ["$subtypeDetails.subtypeName", 0] } };
    }
    // Level 3: Group by plant + subtype + month
    else if (levelNum === 3) {
      groupStage._id = {
        plantId: "$plantName",
        subtypeId: "$plantSubtype",
        year: { $year: "$orderBookingDate" },
        month: { $month: "$orderBookingDate" }
      };
      groupStage.subtypeId = { $first: "$plantSubtype" };
      groupStage.subtypeName = { $first: { $arrayElemAt: ["$subtypeDetails.subtypeName", 0] } };
      groupStage.year = { $first: { $year: "$orderBookingDate" } };
      groupStage.month = { $first: { $month: "$orderBookingDate" } };
    }
    // Level 4: Group by plant + subtype + month + day
    else if (levelNum === 4) {
      groupStage._id = {
        plantId: "$plantName",
        subtypeId: "$plantSubtype",
        year: { $year: "$orderBookingDate" },
        month: { $month: "$orderBookingDate" },
        day: { $dayOfMonth: "$orderBookingDate" }
      };
      groupStage.subtypeId = { $first: "$plantSubtype" };
      groupStage.subtypeName = { $first: { $arrayElemAt: ["$subtypeDetails.subtypeName", 0] } };
      groupStage.year = { $first: { $year: "$orderBookingDate" } };
      groupStage.month = { $first: { $month: "$orderBookingDate" } };
      groupStage.day = { $first: { $dayOfMonth: "$orderBookingDate" } };
    }
    // Level 5: Individual orders
    else if (levelNum === 5) {
      groupStage._id = "$_id";
      groupStage.orderId = { $first: "$_id" };
      groupStage.numberOfPlants = { $first: "$numberOfPlants" };
      groupStage.rate = { $first: "$rate" };
      groupStage.orderStatus = { $first: "$orderStatus" };
      groupStage.farmer = { $first: "$farmer" };
      groupStage.orderBookingDate = { $first: "$orderBookingDate" };
      groupStage.deliveryDate = { $first: "$deliveryDate" };
    }

    pipeline.push({ $group: groupStage });

    // Format output based on level
    const projectStage = {
      _id: 0,
      totalOrders: 1,
      totalPlants: 1,
      totalAmount: 1,
      plantId: 1,
      plantName: 1
    };

    if (levelNum >= 2) {
      projectStage.subtypeId = 1;
      projectStage.subtypeName = 1;
    }

    if (levelNum >= 3) {
      projectStage.year = 1;
      projectStage.month = 1;
      projectStage.monthName = {
        $let: {
          vars: {
            months: ["", "January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"]
          },
          in: { $arrayElemAt: ["$$months", "$month"] }
        }
      };
      projectStage.monthKey = { $concat: [{ $toString: "$year" }, "-", { $toString: "$month" }] };
    }

    if (levelNum >= 4) {
      projectStage.day = 1;
      projectStage.dayName = {
        $concat: [
          { $toString: "$day" },
          " ",
          {
            $let: {
              vars: {
                months: ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
              },
              in: { $arrayElemAt: ["$$months", "$month"] }
            }
          },
          " ",
          { $toString: "$year" }
        ]
      };
      projectStage.dayKey = { $concat: [{ $toString: "$year" }, "-", { $toString: "$month" }, "-", { $toString: "$day" }] };
    }

    if (levelNum === 5) {
      projectStage.orderId = 1;
      projectStage.numberOfPlants = 1;
      projectStage.rate = 1;
      projectStage.orderStatus = 1;
      projectStage.farmer = 1;
      projectStage.orderBookingDate = 1;
      projectStage.deliveryDate = 1;
    }

    pipeline.push({ $project: projectStage });

    // Sort results
    const sortStage = {};
    if (levelNum === 1) {
      sortStage.plantName = 1;
    } else if (levelNum === 2) {
      sortStage.subtypeName = 1;
    } else if (levelNum === 3) {
      sortStage.year = 1;
      sortStage.month = 1;
    } else if (levelNum === 4) {
      sortStage.year = 1;
      sortStage.month = 1;
      sortStage.day = 1;
    } else {
      sortStage.orderBookingDate = -1;
    }
    pipeline.push({ $sort: sortStage });

    const results = await Order.aggregate(pipeline);

    return res.status(200).json({
      success: true,
      data: results
    });
  } catch (error) {
    console.error("Error in getOrderBucketing:", error);
    return res.status(500).json({
      success: false,
      message: "An error occurred while fetching bucketing data.",
      error: error.message
    });
  }
});

// Salesmen Bucketing - Hierarchical grouping of orders by salesperson and location
const getSalesmenBucketing = catchAsync(async (req, res, next) => {
  try {
    const { level, startDate, endDate, status, salesPersonId, district, taluka, village } = req.query;

    // Validate level parameter
    const levelNum = parseInt(level);
    if (!levelNum || levelNum < 1 || levelNum > 5) {
      return res.status(400).json({
        success: false,
        message: "Level must be between 1 and 5"
      });
    }

    // Build match filter
    const matchFilter = {};

    // Date filter
    if (startDate || endDate) {
      matchFilter.orderBookingDate = {};
      if (startDate) {
        matchFilter.orderBookingDate.$gte = new Date(startDate);
      }
      if (endDate) {
        matchFilter.orderBookingDate.$lte = new Date(endDate);
      }
    }

    // Status filter
    if (status) {
      matchFilter.orderStatus = status;
    }

    // Salesperson filter
    if (salesPersonId) {
      matchFilter.salesPerson = new mongoose.Types.ObjectId(salesPersonId);
    }

    let pipeline = [{ $match: matchFilter }];

    // Add lookup for salesperson (User) information
    pipeline.push({
      $lookup: {
        from: "users",
        localField: "salesPerson",
        foreignField: "_id",
        as: "salesPersonDetails"
      }
    });

    // Add lookup for farmer information (for location data)
    pipeline.push({
      $lookup: {
        from: "farmers",
        localField: "farmer",
        foreignField: "_id",
        as: "farmerDetails"
      }
    });

    // Unwind farmer details (assuming one farmer per order)
    pipeline.push({
      $unwind: {
        path: "$farmerDetails",
        preserveNullAndEmptyArrays: true // Handle dealer orders that might not have a farmer
      }
    });

    // Add location filters after lookup (farmerDetails fields are now available)
    const locationFilter = {};
    if (district) {
      locationFilter["farmerDetails.district"] = district;
    }
    if (taluka) {
      locationFilter["farmerDetails.taluka"] = taluka;
    }
    if (village) {
      locationFilter["farmerDetails.village"] = village;
    }
    if (Object.keys(locationFilter).length > 0) {
      pipeline.push({ $match: locationFilter });
    }

    // Group by level
    const groupStage = {
      totalOrders: { $sum: 1 },
      totalPlants: { $sum: "$numberOfPlants" },
      totalAmount: { $sum: { $multiply: ["$numberOfPlants", "$rate"] } },
      salesPersonId: { $first: "$salesPerson" },
      salesPersonName: { $first: { $arrayElemAt: ["$salesPersonDetails.name", 0] } },
      salesPersonPhone: { $first: { $arrayElemAt: ["$salesPersonDetails.phoneNumber", 0] } }
    };

    // Level 1: Group by salesperson
    if (levelNum === 1) {
      groupStage._id = "$salesPerson";
    }
    // Level 2: Group by salesperson + district
    else if (levelNum === 2) {
      groupStage._id = {
        salesPersonId: "$salesPerson",
        district: "$farmerDetails.district"
      };
      groupStage.district = { $first: "$farmerDetails.district" };
      groupStage.districtName = { $first: "$farmerDetails.districtName" };
    }
    // Level 3: Group by salesperson + district + taluka
    else if (levelNum === 3) {
      groupStage._id = {
        salesPersonId: "$salesPerson",
        district: "$farmerDetails.district",
        taluka: "$farmerDetails.taluka"
      };
      groupStage.district = { $first: "$farmerDetails.district" };
      groupStage.districtName = { $first: "$farmerDetails.districtName" };
      groupStage.taluka = { $first: "$farmerDetails.taluka" };
      groupStage.talukaName = { $first: "$farmerDetails.talukaName" };
    }
    // Level 4: Group by salesperson + district + taluka + village
    else if (levelNum === 4) {
      groupStage._id = {
        salesPersonId: "$salesPerson",
        district: "$farmerDetails.district",
        taluka: "$farmerDetails.taluka",
        village: "$farmerDetails.village"
      };
      groupStage.district = { $first: "$farmerDetails.district" };
      groupStage.districtName = { $first: "$farmerDetails.districtName" };
      groupStage.taluka = { $first: "$farmerDetails.taluka" };
      groupStage.talukaName = { $first: "$farmerDetails.talukaName" };
      groupStage.village = { $first: "$farmerDetails.village" };
    }
    // Level 5: Individual orders
    else if (levelNum === 5) {
      groupStage._id = "$_id";
      groupStage.orderId = { $first: "$_id" };
      groupStage.numberOfPlants = { $first: "$numberOfPlants" };
      groupStage.rate = { $first: "$rate" };
      groupStage.orderStatus = { $first: "$orderStatus" };
      groupStage.farmer = { $first: "$farmer" };
      groupStage.orderBookingDate = { $first: "$orderBookingDate" };
      groupStage.deliveryDate = { $first: "$deliveryDate" };
      groupStage.district = { $first: "$farmerDetails.district" };
      groupStage.districtName = { $first: "$farmerDetails.districtName" };
      groupStage.taluka = { $first: "$farmerDetails.taluka" };
      groupStage.talukaName = { $first: "$farmerDetails.talukaName" };
      groupStage.village = { $first: "$farmerDetails.village" };
    }

    pipeline.push({ $group: groupStage });

    // Format output based on level
    const projectStage = {
      _id: 0,
      totalOrders: 1,
      totalPlants: 1,
      totalAmount: 1,
      salesPersonId: 1,
      salesPersonName: 1,
      salesPersonPhone: 1
    };

    if (levelNum >= 2) {
      projectStage.district = 1;
      projectStage.districtName = 1;
    }

    if (levelNum >= 3) {
      projectStage.taluka = 1;
      projectStage.talukaName = 1;
    }

    if (levelNum >= 4) {
      projectStage.village = 1;
    }

    if (levelNum === 5) {
      projectStage.orderId = 1;
      projectStage.numberOfPlants = 1;
      projectStage.rate = 1;
      projectStage.orderStatus = 1;
      projectStage.farmer = 1;
      projectStage.orderBookingDate = 1;
      projectStage.deliveryDate = 1;
    }

    pipeline.push({ $project: projectStage });

    // Sort results
    const sortStage = {};
    if (levelNum === 1) {
      sortStage.salesPersonName = 1;
    } else if (levelNum === 2) {
      sortStage.districtName = 1;
    } else if (levelNum === 3) {
      sortStage.talukaName = 1;
    } else if (levelNum === 4) {
      sortStage.village = 1;
    } else {
      sortStage.orderBookingDate = -1;
    }
    pipeline.push({ $sort: sortStage });

    const results = await Order.aggregate(pipeline);

    return res.status(200).json({
      success: true,
      data: results
    });
  } catch (error) {
    console.error("Error in getSalesmenBucketing:", error);
    return res.status(500).json({
      success: false,
      message: "An error occurred while fetching salesmen bucketing data.",
      error: error.message
    });
  }
});

// Payment Activity Controllers
const createPaymentActivity = catchAsync(async (req, res, next) => {
  try {
    const {
      orderId,
      paymentId,
      activityType,
      activityDescription,
      paymentType,
      paymentAmount,
      previousStatus,
      newStatus,
      performedBy,
      timestamp,
      metadata
    } = req.body;

    const paymentActivity = new PaymentActivity({
      orderId,
      paymentId,
      activityType,
      activityDescription,
      paymentType,
      paymentAmount,
      previousStatus,
      newStatus,
      performedBy,
      timestamp: timestamp ? new Date(timestamp) : new Date(),
      metadata
    });

    await paymentActivity.save();

    return res.status(201).json({
      success: true,
      message: "Payment activity logged successfully",
      data: paymentActivity
    });
  } catch (error) {
    console.error("Error creating payment activity:", error);
    return res.status(500).json({
      success: false,
      message: "An error occurred while logging payment activity",
      error: error.message
    });
  }
});

const getPaymentActivities = catchAsync(async (req, res, next) => {
  try {
    const { startDate, endDate } = req.query;
    
    const query = {};
    
    if (startDate && endDate) {
      query.timestamp = {
        $gte: new Date(startDate),
        $lte: new Date(endDate)
      };
    }

    const activities = await PaymentActivity.find(query)
      .populate('orderId', 'orderId')
      .populate('performedBy.userId', 'name phoneNumber')
      .sort({ timestamp: -1 })
      .limit(1000);

    return res.status(200).json({
      success: true,
      message: "Payment activities fetched successfully",
      data: activities
    });
  } catch (error) {
    console.error("Error fetching payment activities:", error);
    return res.status(500).json({
      success: false,
      message: "An error occurred while fetching payment activities",
      error: error.message
    });
  }
});

const getTodaysPaymentActivities = catchAsync(async (req, res, next) => {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    const activities = await PaymentActivity.find({
      timestamp: {
        $gte: today,
        $lt: tomorrow
      }
    })
      .populate('orderId', 'orderId')
      .populate('performedBy.userId', 'name phoneNumber')
      .sort({ timestamp: -1 })
      .limit(500);

    return res.status(200).json({
      success: true,
      message: "Today's payment activities fetched successfully",
      data: activities
    });
  } catch (error) {
    console.error("Error fetching today's payment activities:", error);
    return res.status(500).json({
      success: false,
      message: "An error occurred while fetching today's payment activities",
      error: error.message
    });
  }
});

/**
 * Send order accepted WhatsApp (WATI order_accpeted_revamped).
 * Auto on first COLLECTED payment; manual retry via POST send-accepted-whatsapp.
 */
export const sendOrderAcceptedWhatsAppController = catchAsync(async (req, res) => {
  const { orderId } = req.params;
  const order = await Order.findById(orderId)
    .populate("farmer", "name mobileNumber village taluka talukaName")
    .populate("salesPerson", "name phoneNumber jobTitle")
    .populate("plantName", "name");
  if (!order) {
    return res.status(404).json({ message: "Order not found" });
  }

  const result = await sendOrderAcceptedWhatsAppForOrder(order);

  if (result.alreadySent) {
    return res.status(200).json(
      generateResponse(
        "Success",
        "WhatsApp accept message was already sent for this order",
        {
          alreadySent: true,
          whatsappAcceptedSentAt: result.whatsappAcceptedSentAt,
          whatsappAcceptedMessageKey: result.whatsappAcceptedMessageKey || null,
        },
        undefined
      )
    );
  }

  if (!result.success) {
    const msg =
      result.error?.message ||
      (typeof result.error === "string" ? result.error : "Failed to send message");
    return res.status(500).json(generateResponse("Error", msg, null, result.error));
  }

  return res.status(200).json(
    generateResponse("Success", "WhatsApp message sent successfully", {
      ...result.data,
      stored: result.stored,
      farmerSent: result.farmerSent ?? false,
      dealerSent: result.dealerSent ?? false,
      dealerAlsoSent: result.dealerAlsoSent,
      ...(result.dealerSendNote ? { dealerSendWarning: result.dealerSendNote } : {}),
    }, undefined)
  );
});

/**
 * Send dispatch WhatsApp (WATI template delivery_final_revamp) to farmer after order is dispatched
 */
export const sendOrderDispatchWhatsAppController = catchAsync(async (req, res) => {
  const { orderId } = req.params;
  const order = await Order.findById(orderId)
    .populate("farmer", "name mobileNumber village")
    .populate("salesPerson", "name phoneNumber jobTitle")
    .populate("plantName", "name");
  if (!order) {
    return res.status(404).json({ message: "Order not found" });
  }
  if (order.whatsappDispatchSentAt) {
    return res.status(200).json(
      generateResponse("Success", "WhatsApp dispatch message was already sent for this order", {
        alreadySent: true,
        whatsappDispatchSentAt: order.whatsappDispatchSentAt,
        whatsappDispatchMessageKey: order.whatsappDispatchMessageKey || null,
      }, undefined)
    );
  }
  const history = Array.isArray(order.dispatchHistory) ? order.dispatchHistory : [];
  const dispatchedSum = history.reduce((s, h) => s + (Number(h.quantity) || 0), 0);
  const totalPlants = (order.numberOfPlants || 0) + (order.additionalPlants || 0);
  const totalDispatched =
    dispatchedSum > 0 ? dispatchedSum : order.orderStatus === "DISPATCHED" ? totalPlants : 0;
  if (totalDispatched <= 0) {
    return res.status(400).json({ message: "No dispatch recorded for this order yet" });
  }
  if (!order.publicOrderCode) {
    await Order.ensurePublicOrderCode(order);
    await order.save();
  }
  const latest = history.length > 0 ? history[history.length - 1] : null;
  const dispatchDate = latest?.date || new Date();
  const plantSubtypeName = await resolveOrderPlantSubtypeName(order);
  const details = {
    orderId: order.orderId,
    publicOrderCode: order.publicOrderCode,
    plantName: order.plantName?.name || "Plants",
    plantSubtype: plantSubtypeName,
    totalDispatched,
    driverName: latest?.driverName || "N/A",
    driverNumber: latest?.driverMobile || latest?.dispatch?.driverMobile || "N/A",
    vehicleNumber: latest?.vehicleName || "N/A",
    dispatchDate,
    deliveryDate: order.deliveryDate,
  };

  if (order.dealerOrder) {
    const dealerRec = dealerWhatsAppRecipient(order);
    if (!dealerRec) {
      return res.status(400).json({
        message: "Dealer order has no salesperson with a valid mobile number for WhatsApp",
      });
    }
    console.log(
      `[WATI dispatch] Dealer order → ${dealerRec.sendToName || "dealer"} ${dealerRec.mobileNumber}; template customer: ${dealerRec.name} (${dealerRec.village})`
    );
    const result = await sendOrderDispatchedWhatsAppDelivery1(dealerRec, details);
    if (result.success) {
      order.whatsappDispatchSentAt = new Date();
      const msgKey = extractWatiLocalMessageId(result.data);
      if (msgKey) order.whatsappDispatchMessageKey = String(msgKey);
      await order.save();
      return res.status(200).json(
        generateResponse("Success", "WhatsApp dispatch message sent successfully", {
          ...result.data,
          stored: {
            whatsappDispatchSentAt: order.whatsappDispatchSentAt,
            whatsappDispatchMessageKey: order.whatsappDispatchMessageKey || null,
          },
          farmerSent: false,
          dealerSent: true,
        }, undefined)
      );
    }
    return res.status(500).json(generateResponse("Error", result.error?.message || "Failed to send message", null, result.error));
  }

  const farmerRec = farmerWhatsAppRecipient(order);
  if (!farmerRec) {
    return res.status(400).json({
      message: "Order has no farmer with mobile number — farmer WhatsApp is required for this order",
    });
  }
  const farmerResult = await sendOrderDispatchedWhatsAppDelivery1(farmerRec, details);
  if (!farmerResult.success) {
    return res.status(500).json(
      generateResponse("Error", farmerResult.error?.message || "Failed to send message", null, farmerResult.error)
    );
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

  return res.status(200).json(
    generateResponse("Success", "WhatsApp dispatch message sent successfully", {
      ...farmerResult.data,
      stored: {
        whatsappDispatchSentAt: order.whatsappDispatchSentAt,
        whatsappDispatchMessageKey: order.whatsappDispatchMessageKey || null,
      },
      farmerSent: true,
      dealerAlsoSent,
      ...(dealerSendNote ? { dealerSendWarning: dealerSendNote } : {}),
    }, undefined)
  );
});

const getUnclearedPayments = catchAsync(async (req, res) => {
  const { dateFrom, dateTo, source } = req.query;
  const list = await getUnclearedPaymentsService({ dateFrom, dateTo, source: source || "all" });
  return res.status(200).json({ success: true, data: list });
});

const getPaymentsForApproval = catchAsync(async (req, res) => {
  const { dateFrom, dateTo, source } = req.query;
  const list = await getPaymentsForApprovalService({ dateFrom, dateTo, source: source || "all" });
  return res.status(200).json({ success: true, data: list });
});

const reconcilePayments = catchAsync(async (req, res) => {
  const { dateFrom, dateTo, source } = req.body || req.query;
  if (!dateFrom || !dateTo) {
    return res.status(400).json({ success: false, message: "dateFrom and dateTo are required" });
  }
  const result = await reconcileService(dateFrom, dateTo, source || "all");
  return res.status(200).json({ success: true, ...result });
});

/**
 * POST /api/v1/order/:orderId/generate-payment-qr
 * Generate QR for order outstanding. Creates PENDING payment with 30-min expiry.
 */
const generatePaymentQR = catchAsync(async (req, res) => {
  const orderId = req.params.orderId;
  const order = await Order.findById(orderId).populate("farmer", "name village mobileNumber");
  if (!order) {
    return res.status(404).json({ success: false, message: "Order not found" });
  }
  const totalOrderedPlants = (order.numberOfPlants || 0) + (order.additionalPlants || 0);
  const totalAmount = order.rate * totalOrderedPlants;
  const totalCollected = (order.payment || [])
    .filter((p) => p.paymentStatus === "COLLECTED")
    .reduce((sum, p) => sum + (p.paidAmount || 0), 0);
  const outstanding = Math.round((totalAmount - totalCollected) * 100) / 100;
  if (outstanding <= 0) {
    return res.status(400).json({ success: false, message: "No outstanding amount for this order" });
  }
  const now = new Date();
  const hasActiveQR = (order.payment || []).some(
    (p) => p.paymentStatus === "PENDING" && p.qrReferenceId && p.qrExpiresAt && new Date(p.qrExpiresAt) > now
  );
  if (hasActiveQR) {
    return res.status(400).json({ success: false, message: "An active payment QR already exists for this order" });
  }
  const customerName = order.dealerOrder ? "Dealer Order" : (order.farmer?.name || "Customer");
  const mobileNumber = order.farmer?.mobileNumber ? String(order.farmer.mobileNumber) : "";
  let qrResult;
  try {
    qrResult = await generateQR({
      amount: outstanding,
      orderId: order.orderId,
      customerName,
      mobileNumber,
    });
  } catch (err) {
    const n = normalizeIciciError(err);
    return res.status(n.httpStatus).json({ success: false, message: n.message, code: n.code });
  }
  // ICICI merchantTranId must be stored as qrReferenceId so /order/payment/qr-callback can match bank referenceId
  const qrReferenceId = qrResult.merchantTranId;
  const qrExpiresAt = new Date(qrResult.expiresAt || Date.now() + 30 * 60 * 1000);
  const qrImageOrString = qrResult.qrImageBase64 || qrResult.qrString || "";
  const newPayment = {
    paidAmount: outstanding,
    paymentStatus: "PENDING",
    paymentDate: new Date(),
    modeOfPayment: "UPI_QR",
    qrReferenceId,
    merchantTranId: qrReferenceId,
    bankVerificationStatus: "PENDING",
    qrExpiresAt,
    qrImage: qrResult.qrImageBase64 || undefined,
    qrPayload: qrResult.qrString || undefined,
  };
  applyPaymentTimingToPayment(newPayment, order);
  order.payment.push(newPayment);
  await order.save();
  await saveIciciQrAuditRecord({
    orderId: order.orderId,
    merchantTranId: qrReferenceId,
    amount: outstanding,
    context: "FARMER_ORDER",
    linkedOrderMongoId: order._id,
    qrPayload: { qrString: qrResult.qrString, qrImageBase64: qrResult.qrImageBase64 },
    requestPayload: qrResult.requestPayload,
    responsePayload: qrResult.raw,
    expiresAt: qrExpiresAt,
  });
  const added = order.payment[order.payment.length - 1];
  return res.status(200).json({
    success: true,
    paymentId: added._id.toString(),
    qrReferenceId,
    qrImageOrString,
    expiresAt: qrExpiresAt,
    amount: outstanding,
    orderId: order.orderId,
    customerName,
    mobileNumber,
  });
});

/**
 * POST /api/v1/order/payment/qr-callback
 * Webhook for ICICI QR payment notification. Match by referenceId or UTR+amount; set BANK_VERIFIED if PENDING and not expired.
 * referenceId should be ICICI merchantTranId (same value stored as payment.qrReferenceId when QR was generated).
 * Body: { referenceId?, utr?, amount } (referenceId or utr+amount). Idempotent: already BANK_VERIFIED/COLLECTED returns 200.
 */
const handleQRPaymentCallback = catchAsync(async (req, res) => {
  const { referenceId, utr, amount } = req.body || {};
  const ref = (referenceId && String(referenceId).trim()) || (utr && String(utr).trim());
  const amt = amount != null ? Math.round(Number(amount) * 100) / 100 : null;
  if (!ref && amt == null) {
    return res.status(400).json({ success: false, message: "referenceId or (utr and amount) required" });
  }
  const now = new Date();
  const buildQuery = () => {
    const q = { "payment.paymentStatus": "PENDING" };
    if (ref) q["payment.qrReferenceId"] = ref;
    if (amt != null) q["payment.paidAmount"] = amt;
    return q;
  };
  const tryOrder = async () => {
    const orderDoc = await Order.findOne(buildQuery()).select("payment");
    if (!orderDoc) return false;
    for (const p of orderDoc.payment || []) {
      if (p.paymentStatus !== "PENDING") continue;
      if (p.qrExpiresAt && new Date(p.qrExpiresAt) < now) continue;
      const matchRef = ref && p.qrReferenceId && String(p.qrReferenceId).trim() === ref;
      const matchAmount = amt != null && p.paidAmount === amt;
      if (!matchRef && !matchAmount) continue;
      if (ref && !matchRef) continue;
      if (amt != null && !matchAmount) continue;
      p.paymentStatus = "BANK_VERIFIED";
      if (utr && String(utr).trim()) p.transactionId = String(utr).trim();
      await orderDoc.save();
      return true;
    }
    return false;
  };
  let updated = await tryOrder();
  if (!updated) {
    const AgriSalesOrder = (await import("../models/agriSalesOrder.model.js")).default;
    const agriDoc = await AgriSalesOrder.findOne(buildQuery()).select("payment");
    if (agriDoc) {
      for (const p of agriDoc.payment || []) {
        if (p.paymentStatus !== "PENDING") continue;
        if (p.qrExpiresAt && new Date(p.qrExpiresAt) < now) continue;
        const matchRef = ref && p.qrReferenceId && String(p.qrReferenceId).trim() === ref;
        const matchAmount = amt != null && p.paidAmount === amt;
        if (!matchRef && !matchAmount) continue;
        if (ref && !matchRef) continue;
        if (amt != null && !matchAmount) continue;
        p.paymentStatus = "BANK_VERIFIED";
        if (utr && String(utr).trim()) p.transactionId = String(utr).trim();
        await agriDoc.save();
        updated = true;
        break;
      }
    }
  }
  return res.status(200).json({ success: true, updated });
});

// ─── Delivery Analytics: summary status → subtype → taluka → village ─────────
const getDeliverySummary = catchAsync(async (req, res, next) => {
  const { startDate, endDate, plantId } = req.query;

  const parseDate = (dateStr, isEnd = false) => {
    const [day, month, year] = dateStr.split("-");
    return isEnd
      ? new Date(`${year}-${month}-${day}T23:59:59.999Z`)
      : new Date(`${year}-${month}-${day}T00:00:00.000Z`);
  };

  const matchFilter = {};
  if (startDate && endDate) {
    matchFilter.orderBookingDate = { $gte: parseDate(startDate), $lte: parseDate(endDate, true) };
  }
  if (plantId) {
    try { matchFilter.plantName = new mongoose.Types.ObjectId(plantId); } catch (_) {}
  }

  // Single extra query — much faster than per-order lookup
  let subtypeNameMap = {};
  if (plantId) {
    try {
      const plant = await PlantCms.findById(plantId).select("subtypes").lean();
      if (plant?.subtypes) {
        plant.subtypes.forEach(st => { subtypeNameMap[String(st._id)] = st.name; });
      }
    } catch (_) {}
  }

  const pipeline = [
    { $match: matchFilter },

    // Farmer lookup — include village now
    {
      $lookup: {
        from: "farmers",
        localField: "farmer",
        foreignField: "_id",
        pipeline: [{ $project: { _id: 0, village: 1, taluka: 1, talukaName: 1, district: 1, districtName: 1 } }],
        as: "farmerData",
      },
    },

    {
      $set: {
        _village:  { $ifNull: [{ $arrayElemAt: ["$farmerData.village", 0] }, "Unknown"] },
        _taluka: {
          $ifNull: [
            { $arrayElemAt: ["$farmerData.talukaName", 0] },
            { $ifNull: [{ $arrayElemAt: ["$farmerData.taluka", 0] }, "Unknown"] },
          ],
        },
        _district: {
          $ifNull: [
            { $arrayElemAt: ["$farmerData.districtName", 0] },
            { $ifNull: [{ $arrayElemAt: ["$farmerData.district", 0] }, "Unknown"] },
          ],
        },
        _subtypeId:      { $ifNull: [{ $toString: "$plantSubtype" }, "general"] },
        _paymentPending: { $eq: [{ $ifNull: ["$orderPaymentStatus", "PENDING"] }, "PENDING"] },
        _totalAmount:    { $multiply: [{ $ifNull: ["$numberOfPlants", 0] }, { $ifNull: ["$rate", 0] }] },
      },
    },

    // Deepest group: status + subtypeId + taluka + village + paymentPending
    {
      $group: {
        _id: {
          status: "$orderStatus", subtypeId: "$_subtypeId",
          taluka: "$_taluka", district: "$_district", village: "$_village",
          paymentPending: "$_paymentPending",
        },
        count:       { $sum: 1 },
        totalPlants: { $sum: { $ifNull: ["$numberOfPlants", 0] } },
        totalAmount: { $sum: "$_totalAmount" },
      },
    },

    // Roll up to status + subtypeId + taluka + village
    {
      $group: {
        _id: { status: "$_id.status", subtypeId: "$_id.subtypeId", taluka: "$_id.taluka", district: "$_id.district", village: "$_id.village" },
        count:               { $sum: "$count" },
        totalPlants:         { $sum: "$totalPlants" },
        totalAmount:         { $sum: "$totalAmount" },
        paymentPendingCount: { $sum: { $cond: ["$_id.paymentPending", "$count", 0] } },
        paymentPendingAmount:{ $sum: { $cond: ["$_id.paymentPending", "$totalAmount", 0] } },
      },
    },

    // Roll up to status + subtypeId + taluka  (push villages)
    {
      $group: {
        _id: { status: "$_id.status", subtypeId: "$_id.subtypeId", taluka: "$_id.taluka", district: "$_id.district" },
        count:               { $sum: "$count" },
        totalPlants:         { $sum: "$totalPlants" },
        totalAmount:         { $sum: "$totalAmount" },
        paymentPendingCount: { $sum: "$paymentPendingCount" },
        paymentPendingAmount:{ $sum: "$paymentPendingAmount" },
        villages: {
          $push: {
            village: "$_id.village",
            count: "$count", plants: "$totalPlants", amount: "$totalAmount",
            paymentPendingCount: "$paymentPendingCount", paymentPendingAmount: "$paymentPendingAmount",
          },
        },
      },
    },

    // Roll up to status + subtypeId  (push talukas)
    {
      $group: {
        _id: { status: "$_id.status", subtypeId: "$_id.subtypeId" },
        count:               { $sum: "$count" },
        totalPlants:         { $sum: "$totalPlants" },
        totalAmount:         { $sum: "$totalAmount" },
        paymentPendingCount: { $sum: "$paymentPendingCount" },
        paymentPendingAmount:{ $sum: "$paymentPendingAmount" },
        talukas: {
          $push: {
            taluka: "$_id.taluka", district: "$_id.district",
            count: "$count", plants: "$totalPlants", amount: "$totalAmount",
            paymentPendingCount: "$paymentPendingCount", paymentPendingAmount: "$paymentPendingAmount",
            villages: { $sortArray: { input: "$villages", sortBy: { count: -1 } } },
          },
        },
      },
    },

    // Roll up to status  (push subtypes)
    {
      $group: {
        _id: "$_id.status",
        count:               { $sum: "$count" },
        totalPlants:         { $sum: "$totalPlants" },
        totalAmount:         { $sum: "$totalAmount" },
        paymentPendingCount: { $sum: "$paymentPendingCount" },
        paymentPendingAmount:{ $sum: "$paymentPendingAmount" },
        subtypes: {
          $push: {
            subtypeId: "$_id.subtypeId",
            count: "$count", plants: "$totalPlants", amount: "$totalAmount",
            paymentPendingCount: "$paymentPendingCount", paymentPendingAmount: "$paymentPendingAmount",
            talukas: { $sortArray: { input: "$talukas", sortBy: { count: -1 } } },
          },
        },
      },
    },

    {
      $project: {
        _id: 0, status: "$_id",
        count: 1, totalPlants: 1, totalAmount: 1,
        paymentPendingCount: 1, paymentPendingAmount: 1,
        subtypes: { $sortArray: { input: "$subtypes", sortBy: { count: -1 } } },
      },
    },
    { $sort: { count: -1 } },
  ];

  const statusSummary = await Order.aggregate(pipeline).allowDiskUse(false);

  // Attach subtype names from pre-fetched map
  statusSummary.forEach(row => {
    row.subtypes = (row.subtypes || []).map(st => ({
      ...st,
      subtypeName: subtypeNameMap[st.subtypeId] || "General",
    }));
  });

  const total       = statusSummary.reduce((a, s) => a + s.count, 0);
  const totalPlants = statusSummary.reduce((a, s) => a + s.totalPlants, 0);
  const totalAmount = statusSummary.reduce((a, s) => a + (s.totalAmount || 0), 0);

  const dispatchedStatuses = ["DISPATCHED", "COMPLETED", "PARTIALLY_COMPLETED"];
  const dispatchedPaymentPending = statusSummary
    .filter(s => dispatchedStatuses.includes(s.status))
    .reduce((a, s) => a + (s.paymentPendingCount || 0), 0);
  const dispatchedPaymentPendingAmount = statusSummary
    .filter(s => dispatchedStatuses.includes(s.status))
    .reduce((a, s) => a + (s.paymentPendingAmount || 0), 0);

  return res.status(200).json({
    success: true,
    data: {
      statusSummary,
      total, totalPlants, totalAmount,
      insights: {
        dispatchedPaymentPending,
        dispatchedPaymentPendingAmount,
        readyForDispatch:        statusSummary.find(s => s.status === "READY_FOR_DISPATCH")?.count || 0,
        accepted:                statusSummary.find(s => s.status === "ACCEPTED")?.count || 0,
        completed:               statusSummary.find(s => s.status === "COMPLETED")?.count || 0,
        completedPaymentPending: statusSummary.find(s => s.status === "COMPLETED")?.paymentPendingCount || 0,
      },
    },
  });
});

// ─── Delivery Analytics: lean paginated order list ────────────────────────────
const getDeliveryOrders = catchAsync(async (req, res, next) => {
  const { startDate, endDate, plantId, status, subtypeId, village, paymentStatus, page = 1, limit = 100 } = req.query;

  const parseDate = (dateStr, isEnd = false) => {
    const [day, month, year] = dateStr.split("-");
    return isEnd
      ? new Date(`${year}-${month}-${day}T23:59:59.999Z`)
      : new Date(`${year}-${month}-${day}T00:00:00.000Z`);
  };

  const matchFilter = {};
  if (startDate && endDate) {
    matchFilter.orderBookingDate = { $gte: parseDate(startDate), $lte: parseDate(endDate, true) };
  }
  if (plantId) { try { matchFilter.plantName = new mongoose.Types.ObjectId(plantId); } catch (_) {} }
  if (status)  { matchFilter.orderStatus = { $in: status.split(",").map(s => s.trim()) }; }
  if (subtypeId && subtypeId !== "general") {
    try { matchFilter.plantSubtype = new mongoose.Types.ObjectId(subtypeId); } catch (_) {}
  }
  // Village filter: pre-query matching farmer IDs (single fast indexed query)
  if (village) {
    try {
      const farmerIds = await Farmer.find({ village: village.trim() }).select("_id").lean();
      matchFilter.farmer = { $in: farmerIds.map(f => f._id) };
    } catch (_) {}
  }
  if (paymentStatus) { matchFilter.orderPaymentStatus = paymentStatus.trim(); }

  const skip = (parseInt(page, 10) - 1) * parseInt(limit, 10);
  const limitNum = parseInt(limit, 10);

  const [result] = await Order.aggregate([
    { $match: matchFilter },
    { $sort: { orderBookingDate: -1 } },
    {
      $facet: {
        totalCount: [{ $count: "count" }],
        orders: [
          { $skip: skip }, { $limit: limitNum },
          {
            $lookup: {
              from: "farmers", localField: "farmer", foreignField: "_id",
              pipeline: [{ $project: { _id: 0, name: 1, mobileNumber: 1, village: 1, taluka: 1, talukaName: 1, district: 1, districtName: 1 } }],
              as: "farmerData",
            },
          },
          {
            $lookup: {
              from: "plantcms", localField: "plantName", foreignField: "_id",
              pipeline: [{ $project: { name: 1 } }],
              as: "plantData",
            },
          },
          {
            $project: {
              orderId: 1, orderStatus: 1, numberOfPlants: 1, remainingPlants: 1,
              rate: 1, orderBookingDate: 1, deliveryDate: 1,
              orderPaymentStatus: 1, paymentCompleted: 1,
              farmer: {
                name: { $arrayElemAt: ["$farmerData.name", 0] },
                mobileNumber: { $arrayElemAt: ["$farmerData.mobileNumber", 0] },
                village: { $arrayElemAt: ["$farmerData.village", 0] },
                taluka: { $ifNull: [{ $arrayElemAt: ["$farmerData.talukaName", 0] }, { $arrayElemAt: ["$farmerData.taluka", 0] }] },
                district: { $ifNull: [{ $arrayElemAt: ["$farmerData.districtName", 0] }, { $arrayElemAt: ["$farmerData.district", 0] }] },
              },
              plantType: {
                id: { $arrayElemAt: ["$plantData._id", 0] },
                name: { $arrayElemAt: ["$plantData.name", 0] },
              },
            },
          },
        ],
      },
    },
  ]).allowDiskUse(false);

  const total = result?.totalCount?.[0]?.count || 0;
  return res.status(200).json({
    success: true,
    data: { orders: result?.orders || [], total, page: parseInt(page, 10), limit: limitNum, totalPages: Math.ceil(total / limitNum) },
  });
});

/**
 * Split an order into two separate orders.
 *
 * The caller specifies how many plants to "split off" into a new child order.
 * The parent order's `numberOfPlants` and `remainingPlants` are reduced by
 * `splitQuantity`. A new child order is created with the split quantity,
 * inheriting all dispatch-relevant fields from the parent.
 *
 * Both orders receive a `splitHistory` entry and the parent's `orderEditHistory`
 * records the quantity change.
 *
 * POST /order/:orderId/split
 * Body: { splitQuantity: Number, notes?: String }
 */
const splitOrder = catchAsync(async (req, res, next) => {
  const { orderId } = req.params;
  const { splitQuantity, notes } = req.body;

  if (!splitQuantity || isNaN(Number(splitQuantity)) || Number(splitQuantity) < 1) {
    return next(new AppError("splitQuantity must be a positive number", 400));
  }
  const qty = Number(splitQuantity);

  const SPLITTABLE_STATUSES = ["ACCEPTED", "FARM_READY", "READY_FOR_DISPATCH"];

  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const parent = await Order.findById(orderId).session(session);
    if (!parent) {
      await session.abortTransaction();
      return next(new AppError("Order not found", 404));
    }

    if (!SPLITTABLE_STATUSES.includes(parent.orderStatus)) {
      await session.abortTransaction();
      return next(
        new AppError(
          `Cannot split an order with status "${parent.orderStatus}". Only ${SPLITTABLE_STATUSES.join(", ")} orders can be split.`,
          400
        )
      );
    }

    const effectiveRemaining = parent.remainingPlants ?? parent.numberOfPlants;
    if (qty >= effectiveRemaining) {
      await session.abortTransaction();
      return next(
        new AppError(
          `splitQuantity (${qty}) must be less than the order's remaining plants (${effectiveRemaining})`,
          400
        )
      );
    }

    const performedBy = req.user?._id ?? null;
    const parentOriginalQty = parent.numberOfPlants;
    const parentOriginalRemaining = effectiveRemaining;
    const parentNewRemaining = parentOriginalRemaining - qty;
    const parentNewQty = parent.numberOfPlants - qty;

    // Compute the next orderId (same pattern as factory.controller.js)
    const lastOrder = await Order.findOne()
      .sort({ orderId: -1 })
      .select("orderId")
      .session(session);
    const lastOrderId = Number(lastOrder?.orderId || 0);
    const nextOrderId = lastOrderId < 1000 ? 1000 : lastOrderId + 1;

    // Build child order — clone all dispatch-relevant fields from the parent
    const childData = {
      orderId: nextOrderId,
      farmer: parent.farmer,
      dealer: parent.dealer,
      dealerOrder: parent.dealerOrder,
      salesPerson: parent.salesPerson,
      plantName: parent.plantName,
      plantSubtype: parent.plantSubtype,
      bookingSlot: parent.bookingSlot,
      cavity: parent.cavity,
      rate: parent.rate,
      orderStatus: parent.orderStatus,
      orderPaymentStatus: "PENDING",
      paymentCompleted: false,
      notes: parent.notes,
      orderRemarks: parent.orderRemarks,
      productName: parent.productName,
      productMappingId: parent.productMappingId,
      productOrderSnapshot: parent.productOrderSnapshot,
      orderBookingDate: parent.orderBookingDate,
      deliveryDate: parent.deliveryDate,
      dispatchDayKey: parent.dispatchDayKey,
      dispatchTargetDate: parent.dispatchTargetDate,
      farmReadyDate: parent.farmReadyDate,
      orderFor: parent.orderFor,
      expectedNursery: parent.expectedNursery,
      reference: parent.reference,
      placedByOfficeAdmin: parent.placedByOfficeAdmin,
      orderSubmittedBy: parent.orderSubmittedBy,
      quotaSource: parent.quotaSource,
      numberOfPlants: qty,
      additionalPlants: 0,
      totalPlants: qty,
      remainingPlants: qty,
      returnedPlants: 0,
      // Split tracking
      parentOrderId: parent._id,
      isSplit: true,
      splitHistory: [
        {
          action: "SPLIT_CREATED",
          relatedOrderId: parent._id,
          relatedOrderCode: parent.publicOrderCode,
          relatedOrderNumber: parent.orderId,
          originalQuantity: parentOriginalQty,
          quantityAfterSplit: qty,
          splitQuantity: qty,
          performedBy,
          notes: notes || null,
        },
      ],
      statusChanges: [
        {
          previousStatus: parent.orderStatus,
          newStatus: parent.orderStatus,
          reason: `Created via order split from order #${parent.orderId}`,
          changedBy: performedBy,
        },
      ],
    };

    const [childOrder] = await Order.create([childData], { session });

    // Update parent: reduce quantity, record split child, push audit entries
    const splitHistoryEntry = {
      action: "SPLIT_SOURCE",
      relatedOrderId: childOrder._id,
      relatedOrderCode: childOrder.publicOrderCode,
      relatedOrderNumber: childOrder.orderId,
      originalQuantity: parentOriginalQty,
      quantityAfterSplit: parentNewQty,
      splitQuantity: qty,
      performedBy,
      notes: notes || null,
    };

    const editHistoryEntry = {
      field: "numberOfPlants",
      previousValue: parentOriginalQty,
      newValue: parentNewQty,
      changedBy: performedBy,
      notes: `Split ${qty} plants into new order #${childOrder.orderId}`,
    };

    await Order.findByIdAndUpdate(
      parent._id,
      {
        $set: {
          numberOfPlants: parentNewQty,
          remainingPlants: parentNewRemaining,
          totalPlants: parentNewQty + (parent.additionalPlants ?? 0),
        },
        $push: {
          splitOrderIds: childOrder._id,
          splitHistory: splitHistoryEntry,
          orderEditHistory: editHistoryEntry,
        },
      },
      { session, new: true }
    );

    await session.commitTransaction();

    const { emitPlantSplitEvents } = await import("../utils/orderEventDualWrite.js");
    await emitPlantSplitEvents(parent._id, childOrder._id, {
      splitHistoryEntry,
      userId: performedBy,
      isChild: false,
    }).catch((e) => console.error("[OrderEvent] split parent emit:", e?.message || e));
    await emitPlantSplitEvents(parent._id, childOrder._id, {
      splitHistoryEntry: childOrder.splitHistory?.[0],
      userId: performedBy,
      isChild: true,
    }).catch((e) => console.error("[OrderEvent] split child emit:", e?.message || e));

    const updatedParent = await Order.findById(parent._id).lean();
    const populatedChild = await Order.findById(childOrder._id).lean();

    return res.status(201).json(
      generateResponse(true, "Order split successfully", {
        parentOrder: updatedParent,
        childOrder: populatedChild,
      })
    );
  } catch (err) {
    await session.abortTransaction();
    throw err;
  } finally {
    session.endSession();
  }
});

/**
 * GET /order/geo-summary
 * Server-side taluka/village aggregation for dispatch geo drill-down.
 * Mirrors the EXACT same filter logic as getAll (factory.controller.js) so counts
 * match the order list on each tab (queue=dispatched+dateRangeField, ready=ready_for_dispatch).
 */
const getGeoSummary = catchAsync(async (req, res) => {
  const {
    groupBy = "taluka",
    taluka: talukaFilter,
    ready_for_dispatch,
    status: statusRaw,
    startDate,
    endDate,
    dispatched = false,          // same default as getAll
    dateRangeField,              // "delivery" | "booking" — mirrors getAll
    dealer,
    salesPerson,
    plantId,
    subtypeId,
    includePastDueBeyondRange,
    needsDispatch: needsDispatchRaw,
    expectedNursery,
  } = req.query;

  /* ── Resolve date-range field (same logic as resolveOrderDateRangeField in factory) ── */
  const resolveField = () => {
    const f = String(dateRangeField || "").toLowerCase().trim();
    if (f === "booking" || f === "orderbooking" || f === "order_booking") return "orderBookingDate";
    if (f === "delivery") return "deliveryDate";
    return String(dispatched) === "true" ? "deliveryDate" : "orderBookingDate";
  };
  const dateMongoField = resolveField();

  const statusTokens = resolveOrderStatusTokens(needsDispatchRaw, statusRaw);
  const skipDateForFarmReadyOnly =
    statusTokens.length > 0 && statusTokens.every((s) => s === "FARM_READY");

  const pipeline = [];

  /* ── Role-based filter (mirrors getAll exactly) ── */
  if (req.user) {
    const { jobTitle, _id: userId } = req.user;
    if (jobTitle === "SALES") {
      pipeline.push({ $match: { salesPerson: userId } });
    } else if (jobTitle === "DEALER") {
      pipeline.push({ $match: { $or: [{ dealer: userId }, { salesPerson: userId }] } });
    }
  }

  /* salesPerson / dealer query params (admin overrides — same as getAll) */
  if (salesPerson) {
    pipeline.push({ $match: { salesPerson: new mongoose.Types.ObjectId(salesPerson) } });
  }
  if (dealer) {
    const dealerOid = new mongoose.Types.ObjectId(dealer);
    const dealerSelfOnly =
      req.user?.jobTitle === "DEALER" &&
      req.user?._id &&
      String(dealerOid) === String(req.user._id);
    if (!dealerSelfOnly) {
      // Same as getAll: dealer filter is applied on salesPerson field
      pipeline.push({ $match: { salesPerson: dealerOid } });
    }
  }

  /* plantId / subtypeId filters */
  if (plantId && mongoose.Types.ObjectId.isValid(plantId)) {
    pipeline.push({ $match: { plantName: new mongoose.Types.ObjectId(plantId) } });
  }
  if (subtypeId && mongoose.Types.ObjectId.isValid(subtypeId)) {
    pipeline.push({ $match: { plantSubtype: new mongoose.Types.ObjectId(subtypeId) } });
  }

  if (expectedNursery) {
    const nurseryCode = String(expectedNursery).trim().toUpperCase();
    if (nurseryCode) {
      pipeline.push({ $match: { expectedNursery: nurseryCode } });
    }
  }

  /* ── Status filter (same precedence as getAll) ── */
  if (ready_for_dispatch === "true") {
    pipeline.push({ $match: { orderStatus: "READY_FOR_DISPATCH" } });
  } else if (statusTokens.length > 0) {
    const willApplyDateWindow =
      startDate &&
      endDate &&
      String(dispatched) === "false" &&
      !skipDateForFarmReadyOnly;
    if (!willApplyDateWindow) {
      pipeline.push({ $match: { orderStatus: { $in: statusTokens } } });
    }
  }

  /* ── Date range — dispatched=false branch (mirrors getAll) ── */
  if (
    startDate &&
    endDate &&
    String(dispatched) === "false" &&
    !skipDateForFarmReadyOnly
  ) {
    const parseDate = (s, isEnd = false) => {
      const [d, m, y] = s.split("-");
      const dt = new Date(Date.UTC(+y, +m - 1, +d, 0, 0, 0, 0));
      if (isEnd) dt.setUTCHours(23, 59, 59, 999);
      return dt;
    };
    const start = parseDate(startDate);
    const end = parseDate(endDate, true);
    if (
      includePastDueBeyondRange === "true" &&
      dateMongoField === "deliveryDate"
    ) {
      pipeline.push({
        $match: {
          $or: [
            { deliveryDate: { $gte: start, $lte: end } },
            { deliveryDate: { $lt: start } },
          ],
        },
      });
      if (statusTokens.length > 0) {
        pipeline.push({ $match: { orderStatus: { $in: statusTokens } } });
      }
    } else if (statusTokens.length > 0) {
      const combined = buildOrderStatusDateMatch(statusTokens, {
        field: dateMongoField,
        start,
        end,
      });
      if (combined) pipeline.push({ $match: combined });
    } else {
      pipeline.push({
        $match: { [dateMongoField]: { $gte: start, $lte: end } },
      });
    }
  }

  /* ── Date range — dispatched=true branch with includePastDueBeyondRange (mirrors getAll lines 3020-3066) ── */
  if (
    startDate &&
    endDate &&
    String(dispatched) === "true" &&
    ready_for_dispatch !== "true" &&
    !skipDateForFarmReadyOnly
  ) {
    const parseDt = (s, isEnd = false) => {
      const [d, m, y] = s.split("-");
      const dt = new Date(Date.UTC(+y, +m - 1, +d, 0, 0, 0, 0));
      if (isEnd) dt.setUTCHours(23, 59, 59, 999);
      return dt;
    };
    const startD = parseDt(startDate);
    const endD = parseDt(endDate, true);
    if (includePastDueBeyondRange === "true" && dateMongoField === "deliveryDate") {
      pipeline.push({
        $match: {
          $or: [
            { deliveryDate: { $gte: startD, $lte: endD } },
            { deliveryDate: { $lt: startD } },
          ],
        },
      });
    } else {
      pipeline.push({ $match: { [dateMongoField]: { $gte: startD, $lte: endD } } });
    }
  }

  /* ── Farmer lookup + geo field extraction ── */
  pipeline.push({
    $lookup: { from: "farmers", localField: "farmer", foreignField: "_id", as: "_farmerData" },
  });
  /* Skip orders that have no linked farmer (can't be geo-grouped) */
  pipeline.push({ $match: { "_farmerData.0": { $exists: true } } });
  pipeline.push({
    $addFields: {
      _geoTaluka: {
        $trim: {
          input: {
            $toLower: {
              $ifNull: [
                { $arrayElemAt: ["$_farmerData.talukaName", 0] },
                { $arrayElemAt: ["$_farmerData.taluka", 0] },
                "Unknown",
              ],
            },
          },
        },
      },
      _geoVillage: {
        $trim: {
          input: {
            $toLower: {
              $ifNull: [
                { $arrayElemAt: ["$_farmerData.village", 0] },
                { $arrayElemAt: ["$_farmerData.villageName", 0] },
                "Unknown",
              ],
            },
          },
        },
      },
      _geoTalukaDisplay: {
        $ifNull: [
          { $arrayElemAt: ["$_farmerData.talukaName", 0] },
          { $arrayElemAt: ["$_farmerData.taluka", 0] },
          "Unknown",
        ],
      },
      _geoVillageDisplay: {
        $ifNull: [
          { $arrayElemAt: ["$_farmerData.village", 0] },
          { $arrayElemAt: ["$_farmerData.villageName", 0] },
          "Unknown",
        ],
      },
    },
  });

  /* ── Filter to specific taluka when grouping by village ── */
  if (groupBy === "village" && talukaFilter) {
    pipeline.push({
      $match: {
        $or: [
          { _geoTaluka: new RegExp(`^${talukaFilter.trim()}$`, "i") },
          { _geoTalukaDisplay: new RegExp(`^${talukaFilter.trim()}$`, "i") },
        ],
      },
    });
  }

  /* ── Plant lookup for plant-type breakdown ── */
  pipeline.push({
    $lookup: { from: "plantcms", localField: "plantName", foreignField: "_id", as: "_plantData" },
  });
  pipeline.push({
    $addFields: {
      _plantDisplayName: { $ifNull: [{ $arrayElemAt: ["$_plantData.name", 0] }, "Unknown"] },
      _qty: { $ifNull: ["$remainingPlants", "$numberOfPlants", 0] },
    },
  });

  /* ── Stage 1: group by (geo + plant) ── */
  const geoDisplayField = groupBy === "village" ? "$_geoVillageDisplay" : "$_geoTalukaDisplay";
  const geoKeyField     = groupBy === "village" ? "$_geoVillage"        : "$_geoTaluka";
  pipeline.push({
    $group: {
      _id: { geo: geoDisplayField, geoKey: geoKeyField, plant: "$_plantDisplayName" },
      plantQty: { $sum: "$_qty" },
      orderCount: { $sum: 1 },
      splitCount: {
        $sum: {
          $cond: [
            { $or: [
              { $eq: ["$isSplit", true] },
              { $gt: [{ $size: { $ifNull: ["$splitOrderIds", []] } }, 0] },
            ]},
            1, 0,
          ],
        },
      },
    },
  });

  /* ── Stage 2: group by geo, collect plants ── */
  pipeline.push({
    $group: {
      _id: { geo: "$_id.geo", geoKey: "$_id.geoKey" },
      orderCount: { $sum: "$orderCount" },
      splitCount: { $sum: "$splitCount" },
      plants: { $push: { name: "$_id.plant", total: "$plantQty" } },
    },
  });

  pipeline.push({ $sort: { orderCount: -1 } });

  const results = await Order.aggregate(pipeline);

  const key = groupBy === "village" ? "village" : "taluka";
  const data = results.map((r) => ({
    [key]: r._id.geo,
    orderCount: r.orderCount,
    splitCount: r.splitCount,
    plantTotals: r.plants
      .filter((p) => p.total > 0)
      .sort((a, b) => b.total - a.total)
      .map((p) => [p.name, p.total]),
  }));

  return res.status(200).json({ success: true, data });
});

// ─── Remaining dispatch queue: aggregate + cell orders (sales × dealer × status) ─
const REMAINING_DISPATCH_STATUSES = ["ACCEPTED", "FARM_READY", "READY_FOR_DISPATCH", "DISPATCH_PROCESS"];

function pushOrderListRoleScopeForRemainingDispatch(pipeline, req) {
  if (!req.user) return;
  const showonly = req.query?.showonly;
  const userId = req.user._id;
  const jt = req.user.jobTitle;
  if (showonly === "true" || showonly === true) {
    pipeline.push({ $match: { salesPerson: userId } });
    return;
  }
  if (jt === "SALES") {
    pipeline.push({ $match: { salesPerson: userId } });
  } else if (jt === "DEALER") {
    pipeline.push({
      $match: {
        $or: [{ dealer: userId }, { salesPerson: userId }],
      },
    });
  }
}

function parseDdMmYyyyUtcRemaining(dateStr, isEnd = false) {
  if (!dateStr || typeof dateStr !== "string") return null;
  const parts = dateStr.split("-");
  if (parts.length !== 3) return null;
  const [day, month, year] = parts;
  const d = isEnd
    ? new Date(`${year}-${month}-${day}T23:59:59.999Z`)
    : new Date(`${year}-${month}-${day}T00:00:00.000Z`);
  return isNaN(d.getTime()) ? null : d;
}

function pushRemainingDispatchDateRangeMatch(pipeline, req) {
  const { startDate, endDate, dateRangeField, includePastDueBeyondRange } = req.query || {};
  if (!startDate || !endDate) return;

  const start = parseDdMmYyyyUtcRemaining(startDate, false);
  const end = parseDdMmYyyyUtcRemaining(endDate, true);
  if (!start || !end) return;

  const f = String(dateRangeField || "").toLowerCase().trim();
  const rangeField =
    f === "booking" || f === "orderbooking" || f === "order_booking" ? "orderBookingDate" : "deliveryDate";

  if (includePastDueBeyondRange === "true" && rangeField === "deliveryDate") {
    pipeline.push({
      $match: {
        $or: [{ deliveryDate: { $gte: start, $lte: end } }, { deliveryDate: { $lt: start } }],
      },
    });
  } else {
    pipeline.push({
      $match: { [rangeField]: { $gte: start, $lte: end } },
    });
  }
}

const getRemainingDispatchAggregate = catchAsync(async (req, res) => {
  const pipeline = [];
  pushOrderListRoleScopeForRemainingDispatch(pipeline, req);
  pipeline.push({
    $match: { orderStatus: { $in: REMAINING_DISPATCH_STATUSES } },
  });
  pushRemainingDispatchDateRangeMatch(pipeline, req);

  pipeline.push(
    {
      $lookup: {
        from: "users",
        localField: "salesPerson",
        foreignField: "_id",
        as: "spDoc",
        pipeline: [{ $project: { name: 1 } }],
      },
    },
    {
      $lookup: {
        from: "users",
        localField: "dealer",
        foreignField: "_id",
        as: "dlDoc",
        pipeline: [{ $project: { name: 1, companyName: 1 } }],
      },
    },
    {
      $addFields: {
        salesName: { $ifNull: [{ $arrayElemAt: ["$spDoc.name", 0] }, "—"] },
        dealerName: {
          $let: {
            vars: {
              cn: { $ifNull: [{ $arrayElemAt: ["$dlDoc.companyName", 0] }, ""] },
              nm: { $ifNull: [{ $arrayElemAt: ["$dlDoc.name", 0] }, ""] },
            },
            in: {
              $cond: [
                { $gt: [{ $strLenCP: { $trim: { input: "$$cn" } } }, 0] },
                "$$cn",
                {
                  $cond: [
                    { $gt: [{ $strLenCP: { $trim: { input: "$$nm" } } }, 0] },
                    "$$nm",
                    "—",
                  ],
                },
              ],
            },
          },
        },
      },
    },
    {
      $group: {
        _id: {
          salesPerson: "$salesPerson",
          dealer: "$dealer",
          orderStatus: "$orderStatus",
        },
        orderCount: { $sum: 1 },
        totalPlants: { $sum: { $ifNull: ["$numberOfPlants", 0] } },
        salesName: { $first: "$salesName" },
        dealerName: { $first: "$dealerName" },
      },
    },
    {
      $project: {
        _id: 0,
        salesPersonId: "$_id.salesPerson",
        dealerId: "$_id.dealer",
        orderStatus: "$_id.orderStatus",
        orderCount: 1,
        totalPlants: 1,
        salesName: 1,
        dealerName: 1,
      },
    },
    { $sort: { totalPlants: -1, orderCount: -1 } }
  );

  const rows = await Order.aggregate(pipeline).allowDiskUse(true);
  const grandTotalPlants = rows.reduce((a, r) => a + (r.totalPlants || 0), 0);
  const grandOrderCount = rows.reduce((a, r) => a + (r.orderCount || 0), 0);

  return res.status(200).json({
    success: true,
    data: {
      rows,
      grandTotalPlants,
      grandOrderCount,
    },
  });
});

const getRemainingDispatchOrdersByCell = catchAsync(async (req, res) => {
  const { status, salesPerson, dealer } = req.query || {};
  if (!status || String(status).trim() === "") {
    return res.status(400).json({ success: false, message: "status is required" });
  }

  const pipeline = [];
  pushOrderListRoleScopeForRemainingDispatch(pipeline, req);

  const st = String(status).trim();
  const and = [{ orderStatus: st }];

  const spQ = salesPerson == null ? "" : String(salesPerson).trim();
  if (!spQ || spQ === "none") {
    and.push({ $or: [{ salesPerson: null }, { salesPerson: { $exists: false } }] });
  } else if (mongoose.Types.ObjectId.isValid(spQ)) {
    and.push({ salesPerson: new mongoose.Types.ObjectId(spQ) });
  } else {
    return res.status(400).json({ success: false, message: "Invalid salesPerson id" });
  }

  const dlQ = dealer == null ? "" : String(dealer).trim();
  if (!dlQ || dlQ === "none") {
    and.push({ $or: [{ dealer: null }, { dealer: { $exists: false } }] });
  } else if (mongoose.Types.ObjectId.isValid(dlQ)) {
    and.push({ dealer: new mongoose.Types.ObjectId(dlQ) });
  } else {
    return res.status(400).json({ success: false, message: "Invalid dealer id" });
  }

  pipeline.push({ $match: { $and: and } });
  pushRemainingDispatchDateRangeMatch(pipeline, req);

  pipeline.push(
    { $sort: { deliveryDate: 1, orderBookingDate: 1 } },
    {
      $lookup: {
        from: "farmers",
        localField: "farmer",
        foreignField: "_id",
        as: "farmerData",
        pipeline: [
          {
            $project: {
              name: 1,
              mobileNumber: 1,
              village: 1,
              taluka: 1,
              district: 1,
            },
          },
        ],
      },
    },
    {
      $lookup: {
        from: "plantcms",
        localField: "plantName",
        foreignField: "_id",
        as: "plantData",
        pipeline: [{ $project: { name: 1, subtypes: 1 } }],
      },
    },
    {
      $addFields: {
        farmer: { $arrayElemAt: ["$farmerData", 0] },
        plantRow: { $arrayElemAt: ["$plantData", 0] },
        plantTypeName: { $arrayElemAt: ["$plantData.name", 0] },
      },
    },
    {
      $addFields: {
        matchedSubtype: {
          $arrayElemAt: [
            {
              $filter: {
                input: { $ifNull: ["$plantRow.subtypes", []] },
                as: "st",
                cond: { $eq: ["$$st._id", "$plantSubtype"] },
              },
            },
            0,
          ],
        },
      },
    },
    {
      $project: {
        _id: 1,
        orderId: 1,
        orderStatus: 1,
        numberOfPlants: 1,
        rate: 1,
        totalAmount: { $multiply: [{ $ifNull: ["$numberOfPlants", 0] }, { $ifNull: ["$rate", 0] }] },
        deliveryDate: 1,
        orderBookingDate: 1,
        farmer: 1,
        plantTypeName: 1,
        plantSubtypeName: "$matchedSubtype.name",
      },
    },
    { $limit: 2000 }
  );

  const orders = await Order.aggregate(pipeline);

  return res.status(200).json({ success: true, data: { orders } });
});

/** Resolve dealer display name (same logic as remaining-dispatch aggregate). */
function addFieldsDealerNameForRemainingDispatch() {
  return {
    $addFields: {
      dealerName: {
        $let: {
          vars: {
            cn: { $ifNull: [{ $arrayElemAt: ["$dlDoc.companyName", 0] }, ""] },
            nm: { $ifNull: [{ $arrayElemAt: ["$dlDoc.name", 0] }, ""] },
            em: { $ifNull: [{ $arrayElemAt: ["$dlDoc.email", 0] }, ""] },
            phStr: {
              $cond: [
                { $eq: [{ $ifNull: [{ $arrayElemAt: ["$dlDoc.phoneNumber", 0] }, null] }, null] },
                "",
                { $toString: { $arrayElemAt: ["$dlDoc.phoneNumber", 0] } },
              ],
            },
          },
          in: {
            $cond: [
              { $gt: [{ $strLenCP: { $trim: { input: "$$cn" } } }, 0] },
              "$$cn",
              {
                $cond: [
                  { $gt: [{ $strLenCP: { $trim: { input: "$$nm" } } }, 0] },
                  "$$nm",
                  {
                    $cond: [
                      { $gt: [{ $strLenCP: { $trim: { input: "$$em" } } }, 0] },
                      "$$em",
                      {
                        $cond: [
                          { $gt: [{ $strLenCP: { $trim: { input: "$$phStr" } } }, 0] },
                          { $trim: { input: "$$phStr" } },
                          "—",
                        ],
                      },
                    ],
                  },
                ],
              },
            ],
          },
        },
      },
    },
  };
}

/** Pivot long cells into rows: cells = order counts, plantCells = sum(numberOfPlants). */
function buildMatrixRowsFromLongCells(longCells) {
  const colSet = new Set();
  const byRow = new Map();
  for (const x of longCells || []) {
    const ck = x.columnKey || "Other";
    colSet.add(ck);
    const rawId = x.rowId;
    const rid =
      rawId == null || rawId === undefined || rawId === ""
        ? "none"
        : typeof rawId === "object" && rawId !== null && rawId.toString
          ? String(rawId)
          : String(rawId);
    if (!byRow.has(rid)) {
      byRow.set(rid, { id: rid, name: null, cells: {}, plantCells: {} });
    }
    const row = byRow.get(rid);
    row.cells[ck] = (row.cells[ck] || 0) + (x.orderCount || 0);
    row.plantCells[ck] = (row.plantCells[ck] || 0) + (x.plantQty || 0);
    const rn = x.rowName != null ? String(x.rowName).trim() : "";
    if (rn && rn !== "—" && !row.name) {
      row.name = rn;
    }
    if (rn && rn !== "—" && row.name === "—") {
      row.name = rn;
    }
  }
  const columnKeys = [...colSet].sort((a, b) =>
    String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: "base" })
  );
  const rows = [...byRow.values()].map((r) => {
    const cells = {};
    const plantCells = {};
    let rowTotal = 0;
    let plantRowTotal = 0;
    columnKeys.forEach((c) => {
      cells[c] = r.cells[c] || 0;
      plantCells[c] = r.plantCells[c] || 0;
      rowTotal += cells[c] || 0;
      plantRowTotal += plantCells[c] || 0;
    });
    let displayName = r.name && String(r.name).trim() && r.name !== "—" ? String(r.name).trim() : null;
    if (!displayName) {
      displayName =
        r.id === "none" ? "Unassigned" : `No profile (…${String(r.id).slice(-6)})`;
    }
    return { id: r.id, name: displayName, cells, plantCells, rowTotal, plantRowTotal };
  });
  rows.sort((a, b) => String(a.name).localeCompare(String(b.name), undefined, { sensitivity: "base" }));
  return { columnKeys, rows };
}

function mergeColumnKeys(a, b) {
  return [...new Set([...(a || []), ...(b || [])])].sort((x, y) =>
    String(x).localeCompare(String(y), undefined, { numeric: true, sensitivity: "base" })
  );
}

/**
 * Plant subtype columns × rows = salesperson OR dealer; cell = order count + plant qty.
 */
const getRemainingDispatchMatrix = catchAsync(async (req, res) => {
  const pipeline = [];
  pushOrderListRoleScopeForRemainingDispatch(pipeline, req);
  pipeline.push({
    $match: { orderStatus: { $in: REMAINING_DISPATCH_STATUSES } },
  });

  pipeline.push(
    {
      $lookup: {
        from: "users",
        localField: "salesPerson",
        foreignField: "_id",
        as: "spDoc",
        pipeline: [{ $project: { name: 1, email: 1, phoneNumber: 1 } }],
      },
    },
    {
      $lookup: {
        from: "users",
        localField: "dealer",
        foreignField: "_id",
        as: "dlDoc",
        pipeline: [{ $project: { name: 1, companyName: 1, email: 1, phoneNumber: 1 } }],
      },
    },
    {
      $lookup: {
        from: "plantcms",
        localField: "plantName",
        foreignField: "_id",
        as: "plantData",
        pipeline: [{ $project: { name: 1, subtypes: 1 } }],
      },
    },
    {
      $addFields: {
        plantRow: { $arrayElemAt: ["$plantData", 0] },
        salesName: {
          $let: {
            vars: {
              n: { $trim: { input: { $ifNull: [{ $arrayElemAt: ["$spDoc.name", 0] }, ""] } } },
              e: { $trim: { input: { $ifNull: [{ $arrayElemAt: ["$spDoc.email", 0] }, ""] } } },
              phStr: {
                $cond: [
                  { $eq: [{ $ifNull: [{ $arrayElemAt: ["$spDoc.phoneNumber", 0] }, null] }, null] },
                  "",
                  { $toString: { $arrayElemAt: ["$spDoc.phoneNumber", 0] } },
                ],
              },
            },
            in: {
              $cond: [
                { $gt: [{ $strLenCP: "$$n" }, 0] },
                "$$n",
                {
                  $cond: [
                    { $gt: [{ $strLenCP: "$$e" }, 0] },
                    "$$e",
                    {
                      $cond: [
                        { $gt: [{ $strLenCP: { $trim: { input: "$$phStr" } } }, 0] },
                        { $trim: { input: "$$phStr" } },
                        "—",
                      ],
                    },
                  ],
                },
              ],
            },
          },
        },
      },
    },
    addFieldsDealerNameForRemainingDispatch(),
    {
      $addFields: {
        matchedSubtype: {
          $arrayElemAt: [
            {
              $filter: {
                input: { $ifNull: ["$plantRow.subtypes", []] },
                as: "st",
                cond: { $eq: ["$$st._id", "$plantSubtype"] },
              },
            },
            0,
          ],
        },
      },
    },
    {
      $addFields: {
        columnKey: { $ifNull: ["$matchedSubtype.name", "Other"] },
      },
    },
    {
      $facet: {
        salesCells: [
          {
            $group: {
              _id: { rowId: "$salesPerson", columnKey: "$columnKey" },
              orderCount: { $sum: 1 },
              plantQty: { $sum: { $ifNull: ["$numberOfPlants", 0] } },
              rowName: { $last: "$salesName" },
            },
          },
          {
            $project: {
              _id: 0,
              rowId: {
                $cond: [
                  {
                    $or: [
                      { $eq: ["$_id.rowId", null] },
                      { $eq: [{ $type: "$_id.rowId" }, "missing"] },
                    ],
                  },
                  "none",
                  { $toString: "$_id.rowId" },
                ],
              },
              columnKey: "$_id.columnKey",
              orderCount: 1,
              plantQty: 1,
              rowName: { $ifNull: ["$rowName", ""] },
            },
          },
        ],
        dealerCells: [
          {
            $group: {
              _id: { rowId: "$dealer", columnKey: "$columnKey" },
              orderCount: { $sum: 1 },
              plantQty: { $sum: { $ifNull: ["$numberOfPlants", 0] } },
              rowName: { $last: "$dealerName" },
            },
          },
          {
            $project: {
              _id: 0,
              rowId: {
                $cond: [
                  {
                    $or: [
                      { $eq: ["$_id.rowId", null] },
                      { $eq: [{ $type: "$_id.rowId" }, "missing"] },
                    ],
                  },
                  "none",
                  { $toString: "$_id.rowId" },
                ],
              },
              columnKey: "$_id.columnKey",
              orderCount: 1,
              plantQty: 1,
              rowName: { $ifNull: ["$rowName", ""] },
            },
          },
        ],
      },
    }
  );

  const pack = (await Order.aggregate(pipeline).allowDiskUse(true))[0] || {
    salesCells: [],
    dealerCells: [],
  };

  const salesBuilt = buildMatrixRowsFromLongCells(pack.salesCells);
  const dealerBuilt = buildMatrixRowsFromLongCells(pack.dealerCells);
  const columnKeys = mergeColumnKeys(salesBuilt.columnKeys, dealerBuilt.columnKeys);

  const fillCols = (rows) =>
    rows.map((r) => {
      const cells = {};
      const plantCells = {};
      let rowTotal = 0;
      let plantRowTotal = 0;
      columnKeys.forEach((c) => {
        cells[c] = r.cells[c] || 0;
        plantCells[c] = r.plantCells[c] || 0;
        rowTotal += cells[c];
        plantRowTotal += plantCells[c];
      });
      return { id: r.id, name: r.name, cells, plantCells, rowTotal, plantRowTotal };
    });

  const salesRows = fillCols(salesBuilt.rows);
  const dealerRows = fillCols(dealerBuilt.rows);

  return res.status(200).json({
    success: true,
    data: {
      columnKeys,
      salesRows,
      dealerRows,
    },
  });
});

/** Orders for matrix cell: sales|dealer row + plant subtype column. */
const getRemainingDispatchMatrixOrders = catchAsync(async (req, res) => {
  const { matrixRole, rowId, columnKey } = req.query || {};
  const role = String(matrixRole || "").toLowerCase();
  if (role !== "sales" && role !== "dealer") {
    return res.status(400).json({ success: false, message: "matrixRole must be sales or dealer" });
  }
  if (columnKey == null || String(columnKey).trim() === "") {
    return res.status(400).json({ success: false, message: "columnKey is required" });
  }

  const col = String(columnKey).trim();
  const rid = rowId == null ? "" : String(rowId).trim();

  const pipeline = [];
  pushOrderListRoleScopeForRemainingDispatch(pipeline, req);

  const and = [{ orderStatus: { $in: REMAINING_DISPATCH_STATUSES } }];

  if (role === "sales") {
    if (!rid || rid === "none") {
      and.push({ $or: [{ salesPerson: null }, { salesPerson: { $exists: false } }] });
    } else if (mongoose.Types.ObjectId.isValid(rid)) {
      and.push({ salesPerson: new mongoose.Types.ObjectId(rid) });
    } else {
      return res.status(400).json({ success: false, message: "Invalid rowId" });
    }
  } else {
    if (!rid || rid === "none") {
      and.push({ $or: [{ dealer: null }, { dealer: { $exists: false } }] });
    } else if (mongoose.Types.ObjectId.isValid(rid)) {
      and.push({ dealer: new mongoose.Types.ObjectId(rid) });
    } else {
      return res.status(400).json({ success: false, message: "Invalid rowId" });
    }
  }

  pipeline.push({ $match: { $and: and } });

  pipeline.push(
    { $sort: { deliveryDate: 1, orderBookingDate: 1 } },
    {
      $lookup: {
        from: "farmers",
        localField: "farmer",
        foreignField: "_id",
        as: "farmerData",
        pipeline: [
          {
            $project: {
              name: 1,
              mobileNumber: 1,
              village: 1,
              taluka: 1,
              district: 1,
            },
          },
        ],
      },
    },
    {
      $lookup: {
        from: "plantcms",
        localField: "plantName",
        foreignField: "_id",
        as: "plantData",
        pipeline: [{ $project: { name: 1, subtypes: 1 } }],
      },
    },
    {
      $addFields: {
        farmer: { $arrayElemAt: ["$farmerData", 0] },
        plantRow: { $arrayElemAt: ["$plantData", 0] },
        plantTypeName: { $arrayElemAt: ["$plantData.name", 0] },
      },
    },
    {
      $addFields: {
        matchedSubtype: {
          $arrayElemAt: [
            {
              $filter: {
                input: { $ifNull: ["$plantRow.subtypes", []] },
                as: "st",
                cond: { $eq: ["$$st._id", "$plantSubtype"] },
              },
            },
            0,
          ],
        },
      },
    },
    {
      $addFields: {
        plantSubtypeName: { $ifNull: ["$matchedSubtype.name", "Other"] },
      },
    },
    {
      $match: {
        plantSubtypeName: col,
      },
    },
    {
      $project: {
        _id: 1,
        orderId: 1,
        orderStatus: 1,
        numberOfPlants: 1,
        rate: 1,
        totalAmount: { $multiply: [{ $ifNull: ["$numberOfPlants", 0] }, { $ifNull: ["$rate", 0] }] },
        deliveryDate: 1,
        orderBookingDate: 1,
        farmer: 1,
        plantTypeName: 1,
        plantSubtypeName: 1,
      },
    },
    { $limit: 2000 }
  );

  const orders = await Order.aggregate(pipeline);

  return res.status(200).json({ success: true, data: { orders } });
});

/**
 * Admin-only dashboard stats:
 * - Today's booking / dispatch / plant counts
 * - Date-range booking table by plant + subtype
 * - Date-range salesperson chart data
 */
const getAdminDashboardStats = catchAsync(async (req, res) => {
  const { startDate, endDate } = req.query;

  // IST today boundaries
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayEnd = new Date();
  todayEnd.setHours(23, 59, 59, 999);

  // ── Today's booking stats (use orderBookingDate — same field as the rest of the app) ─────
  const todayBookingAgg = await Order.aggregate([
    {
      $match: {
        orderBookingDate: { $gte: todayStart, $lte: todayEnd },
        orderStatus: { $nin: ["CANCELLED", "REJECTED", "TEMPORARY_CANCELLED"] },
      },
    },
    {
      $group: {
        _id: null,
        bookingsCount: { $sum: 1 },
        totalPlants: { $sum: { $ifNull: ["$numberOfPlants", 0] } },
      },
    },
  ]);
  const todayBooking = todayBookingAgg[0] || { bookingsCount: 0, totalPlants: 0 };

  // ── Today's dispatch count ─────────────────────────────────────────────────
  const todayDispatchCount = await Dispatch.countDocuments({
    createdAt: { $gte: todayStart, $lte: todayEnd },
  });

  // ── Date-range aggregations (optional) ────────────────────────────────────
  let bookingTable = [];
  let rangeDispatchStats = null;

  if (startDate && endDate) {
    const rangeStart = new Date(startDate);
    rangeStart.setHours(0, 0, 0, 0);
    const rangeEnd = new Date(endDate);
    rangeEnd.setHours(23, 59, 59, 999);

    const rangeMatch = {
      orderBookingDate: { $gte: rangeStart, $lte: rangeEnd },
      orderStatus: { $nin: ["CANCELLED", "REJECTED", "TEMPORARY_CANCELLED"] },
    };

    // Plant+subtype booking breakdown for the range
    bookingTable = await Order.aggregate([
      { $match: rangeMatch },
      {
        $lookup: {
          from: "plantcms",
          localField: "plantName",
          foreignField: "_id",
          as: "_plantData",
          pipeline: [{ $project: { name: 1, subtypes: 1 } }],
        },
      },
      {
        $addFields: {
          _plantRow: { $arrayElemAt: ["$_plantData", 0] },
          _plantTypeName: { $arrayElemAt: ["$_plantData.name", 0] },
        },
      },
      {
        $addFields: {
          _matchedSubtype: {
            $arrayElemAt: [
              {
                $filter: {
                  input: { $ifNull: ["$_plantRow.subtypes", []] },
                  as: "st",
                  cond: { $eq: ["$$st._id", "$plantSubtype"] },
                },
              },
              0,
            ],
          },
        },
      },
      {
        $addFields: {
          _subtypeName: { $ifNull: ["$_matchedSubtype.name", "Other"] },
        },
      },
      {
        $group: {
          _id: { plantName: "$_plantTypeName", subtype: "$_subtypeName" },
          bookingCount: { $sum: 1 },
          totalPlants: { $sum: { $ifNull: ["$numberOfPlants", 0] } },
          dispatchedCount: {
            $sum: {
              $cond: [
                {
                  $in: [
                    "$orderStatus",
                    ["DISPATCH_PROCESS", "PARTIALLY_COMPLETED", "COMPLETED", "DISPATCHED"],
                  ],
                },
                1,
                0,
              ],
            },
          },
          dispatchedPlants: {
            $sum: {
              $cond: [
                {
                  $in: [
                    "$orderStatus",
                    ["DISPATCH_PROCESS", "PARTIALLY_COMPLETED", "COMPLETED", "DISPATCHED"],
                  ],
                },
                {
                  $cond: [
                    // COMPLETED / DISPATCHED = all plants have gone out
                    { $in: ["$orderStatus", ["COMPLETED", "DISPATCHED"]] },
                    { $ifNull: ["$numberOfPlants", 0] },
                    // DISPATCH_PROCESS / PARTIALLY_COMPLETED = plants dispatched so far
                    {
                      $max: [
                        0,
                        {
                          $subtract: [
                            { $ifNull: ["$numberOfPlants", 0] },
                            { $ifNull: ["$remainingPlants", 0] },
                          ],
                        },
                      ],
                    },
                  ],
                },
                0,
              ],
            },
          },
          pendingPlants: {
            $sum: {
              $cond: [
                {
                  $not: [
                    {
                      $in: [
                        "$orderStatus",
                        ["DISPATCH_PROCESS", "PARTIALLY_COMPLETED", "COMPLETED", "DISPATCHED", "CANCELLED"],
                      ],
                    },
                  ],
                },
                { $ifNull: ["$remainingPlants", { $ifNull: ["$numberOfPlants", 0] }] },
                0,
              ],
            },
          },
        },
      },
      {
        $project: {
          _id: 0,
          plantName: { $ifNull: ["$_id.plantName", "Unknown"] },
          subtype: "$_id.subtype",
          bookingCount: 1,
          totalPlants: 1,
          dispatchedCount: 1,
          dispatchedPlants: 1,
          pendingPlants: 1,
        },
      },
      { $sort: { plantName: 1, subtype: 1 } },
    ]);

    // Dispatch count in range
    const dispatchInRange = await Dispatch.countDocuments({
      createdAt: { $gte: rangeStart, $lte: rangeEnd },
    });
    rangeDispatchStats = { dispatchCount: dispatchInRange };
  }

  return res.status(200).json({
    success: true,
    data: {
      today: {
        bookingsCount: todayBooking.bookingsCount,
        totalPlants: todayBooking.totalPlants,
        dispatchCount: todayDispatchCount,
      },
      bookingTable,
      rangeDispatchStats,
    },
  });
});

const getAdminDailyMis = catchAsync(async (req, res) => {
  const { startDate, endDate } = req.query;
  const result = await fetchAdminDailyMis(startDate, endDate);
  if (result.error) {
    return res.status(result.statusCode || 400).json({
      success: false,
      message: result.error,
    });
  }
  return res.status(200).json({
    success: true,
    data: result.data,
  });
});

export { 
  getOrdersBySlot, 
  getCsv, 
  getOrders, 
  createOrder, 
  updateOrder, 
  addNewPayment, 
  updatePaymentStatus, 
  createDealerOrder, 
  addAfterDispatchedOrderIds,
  getOrdersByStatus,
  getAllPayments,
  getUniqueVillages,
  getUniqueDistricts,
  getUniqueTalukas,
  getDealerWalletBalanceForOrder,
  getOrdersToBeDispatched,
  getAllCavitiesFromOrders,
  getOrderBucketing,
  getSalesmenBucketing,
  createPaymentActivity,
  getPaymentActivities,
  getTodaysPaymentActivities,
  getUnclearedPayments,
  getPaymentsForApproval,
  reconcilePayments,
  generatePaymentQR,
  handleQRPaymentCallback,
  getDeliverySummary,
  getDeliveryOrders,
  splitOrder,
  getGeoSummary,
  getRemainingDispatchAggregate,
  getRemainingDispatchOrdersByCell,
  getRemainingDispatchMatrix,
  getRemainingDispatchMatrixOrders,
  getFarmerOrdersDashboardTabCounts,
  getAdminDashboardStats,
  getAdminDailyMis,
};

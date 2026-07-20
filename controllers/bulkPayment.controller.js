import catchAsync from "../utility/catchAsync.js";
import AppError from "../utility/appError.js";
import generateResponse from "../utility/responseFormat.js";
import mongoose from "mongoose";
import BulkPayment from "../models/bulkPayment.model.js";
import Order from "../models/order.model.js";
import AgriSalesOrder from "../models/agriSalesOrder.model.js";
import DealerWallet from "../models/dealerWallet.js";
import User from "../models/user.model.js";
import { createCustomerLedgerEntry } from "../utils/ramAgriLedgerHelper.js";
import {
  ensureFarmerPlantOrderDebit,
  recordFarmerPlantLedgerPaymentTransition,
} from "../utils/farmerPlantOrderLedgerHelper.js";
import { tryAutoSendOrderAcceptedWhatsApp } from "./order.controller.js";
import { isBananaPlantName } from "../utility/watiPlantText.js";

const shouldLogRamAgriLedger = (order) =>
  Boolean(order?.isRamAgriProduct || order?.ramAgriCropId || order?.ramAgriVarietyId);

/**
 * POST /order/bulk-payment
 * Create a main bulk payment entry with allocations (status PENDING).
 * Accept happens only via PATCH /order/bulk-payment/:id/accept.
 */
export const createBulkPayment = catchAsync(async (req, res, next) => {
  const {
    totalAmount,
    paymentDate,
    modeOfPayment,
    bankName,
    receiptPhoto,
    remark,
    transactionId,
    utrNumber,
    allocations,
    source,
  } = req.body;

  if (!totalAmount || !allocations || !Array.isArray(allocations) || allocations.length === 0) {
    return next(new AppError("totalAmount and at least one allocation are required", 400));
  }

  const total = Number(totalAmount);
  if (!Number.isFinite(total) || total <= 0) {
    return next(new AppError("totalAmount must be greater than 0", 400));
  }

  const hasInvalidAllocation = allocations.some((a) => {
    const amount = Number(a.amount);
    return !Number.isFinite(amount) || amount <= 0;
  });
  if (hasInvalidAllocation) {
    return next(new AppError("Each allocation amount must be greater than 0", 400));
  }

  const sum = allocations.reduce((s, a) => s + (Number(a.amount) || 0), 0);
  if (Math.abs(sum - total) > 0.01) {
    return next(new AppError(`Sum of allocations (${sum}) must equal totalAmount (${total})`, 400));
  }

  const normalizedAllocations = allocations.map((a) => ({
    orderId: new mongoose.Types.ObjectId(a.orderId),
    amount: Number(a.amount),
    orderType: a.orderType === "AgriSalesOrder" ? "AgriSalesOrder" : "ORDER",
  }));

  const requesterId = req.user?._id || req.user?.id;
  const isDealer =
    req.user?.role === "DEALER" || req.user?.jobTitle === "DEALER";

  for (const alloc of normalizedAllocations) {
    if (alloc.orderType === "ORDER") {
      const order = await Order.findById(alloc.orderId).select("_id dealer");
      if (!order) return next(new AppError(`Order not found: ${alloc.orderId}`, 400));
      if (isDealer) {
        if (!order.dealer || order.dealer.toString() !== requesterId?.toString()) {
          return next(
            new AppError("You can only include plant orders assigned to your dealer account", 403)
          );
        }
      }
    } else {
      if (isDealer) {
        return next(new AppError("Dealers cannot use bulk payment for Ram Agri orders", 403));
      }
      const order = await AgriSalesOrder.findById(alloc.orderId).select("_id");
      if (!order) return next(new AppError(`AgriSalesOrder not found: ${alloc.orderId}`, 400));
    }
  }

  const bulk = await BulkPayment.create({
    totalAmount: total,
    paymentDate: paymentDate ? new Date(paymentDate) : new Date(),
    modeOfPayment: modeOfPayment || "Cash",
    bankName: bankName || undefined,
    receiptPhoto: Array.isArray(receiptPhoto) ? receiptPhoto : receiptPhoto ? [receiptPhoto] : [],
    remark: remark || undefined,
    transactionId: transactionId || undefined,
    utrNumber: utrNumber?.trim() || undefined,
    allocations: normalizedAllocations,
    source: source || "MIXED",
    createdBy: req.user?._id || req.user?.id,
    paymentStatus: "PENDING",
  });

  const response = generateResponse("Success", "Bulk payment created (PENDING). Accept from Payments page.", bulk);
  res.status(201).json(response);
});

/**
 * GET /order/bulk-payments
 * List main payment entries with filters. Sub-entries are in allocations.
 */
export const getBulkPayments = catchAsync(async (req, res, next) => {
  const { startDate, endDate, paymentStatus, source, page = 1, limit = 50, search, mine, createdBy } = req.query;
  const skip = (Math.max(1, parseInt(page, 10)) - 1) * Math.min(100, Math.max(1, parseInt(limit, 10)));
  const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10)));

  const filter = {};
  const requesterId = req.user?._id || req.user?.id;
  const requesterRole = req.user?.role || req.user?.jobTitle;

  if (paymentStatus) {
    const statuses = paymentStatus.split(",").map((s) => s.trim());
    filter.paymentStatus = statuses.length === 1 ? statuses[0] : { $in: statuses };
  }
  if (source && ["PLANT", "AGRI", "MIXED"].includes(source)) {
    filter.source = source;
  }

  if (startDate && endDate) {
    try {
      const parseDate = (dateStr, isEnd = false) => {
        const d = new Date(dateStr);
        if (isEnd) d.setHours(23, 59, 59, 999);
        else d.setHours(0, 0, 0, 0);
        return d;
      };
      filter.paymentDate = {
        $gte: parseDate(startDate),
        $lte: parseDate(endDate, true),
      };
    } catch (_) {}
  }

  if (search) {
    const isMongoId = /^[a-fA-F0-9]{24}$/.test(search.trim());
    const isNum = /^\d+$/.test(search.trim());
    if (isMongoId) {
      filter._id = new mongoose.Types.ObjectId(search.trim());
    } else if (isNum) {
      filter.$or = [
        { totalAmount: Number(search) },
        { "allocations.amount": Number(search) },
      ];
    }
  }

  if (mine === "true" && requesterId) {
    filter.createdBy = new mongoose.Types.ObjectId(requesterId);
  }
  if (createdBy) {
    if (!mongoose.Types.ObjectId.isValid(createdBy)) {
      return next(new AppError("Invalid createdBy", 400));
    }
    const createdById = new mongoose.Types.ObjectId(createdBy);
    if (requesterRole === "CASHIER" && requesterId && String(createdById) !== String(requesterId)) {
      return next(new AppError("CASHIER can only access own entries", 403));
    }
    filter.createdBy = createdById;
  }

  const [list, total, totals] = await Promise.all([
    BulkPayment.find(filter)
      // Prioritize recently edited rows (e.g. accepted/updated entries) on top.
      .sort({ updatedAt: -1, paymentDate: -1, createdAt: -1 })
      .skip(skip)
      .limit(limitNum)
      .populate("createdBy", "name phoneNumber")
      .populate("acceptedBy", "name phoneNumber")
      .lean(),
    BulkPayment.countDocuments(filter),
    BulkPayment.aggregate([
      { $match: filter },
      { $group: { _id: null, totalAmountSum: { $sum: "$totalAmount" } } },
    ]),
  ]);

  const orderIdsByType = { ORDER: [], AgriSalesOrder: [] };
  list.forEach((bp) => {
    (bp.allocations || []).forEach((a) => {
      if (a.orderType === "AgriSalesOrder") orderIdsByType.AgriSalesOrder.push(a.orderId);
      else orderIdsByType.ORDER.push(a.orderId);
    });
  });

  const [plantOrders, agriOrders] = await Promise.all([
    Order.find({ _id: { $in: orderIdsByType.ORDER } })
      .populate("farmer", "name village mobileNumber")
      .select("orderId farmer dealerOrder")
      .lean(),
    AgriSalesOrder.find({ _id: { $in: orderIdsByType.AgriSalesOrder } })
      .select("orderNumber customerName customerMobile")
      .lean(),
  ]);

  const plantMap = new Map(plantOrders.map((o) => [o._id.toString(), o]));
  const agriMap = new Map(agriOrders.map((o) => [o._id.toString(), o]));

  const enriched = list.map((bp) => {
    const allocationsEnriched = (bp.allocations || []).map((a) => {
      const idStr = a.orderId.toString();
      const orderType = a.orderType || "ORDER";
      const order = orderType === "AgriSalesOrder" ? agriMap.get(idStr) : plantMap.get(idStr);
      return {
        ...a,
        orderNumber: order?.orderId ?? order?.orderNumber ?? idStr,
        customerName: order?.farmer?.name ?? order?.customerName ?? (order?.dealerOrder ? "Dealer Order" : "—"),
        village: order?.farmer?.village ?? order?.customerMobile ?? null,
      };
    });
    return { ...bp, allocations: allocationsEnriched };
  });

  const response = generateResponse(
    "Success",
    "Bulk payments fetched successfully",
    {
      data: enriched,
      total,
      page: Math.max(1, parseInt(page, 10)),
      limit: limitNum,
      totalAmountSum: totals?.[0]?.totalAmountSum || 0,
    }
  );
  res.status(200).json(response);
});

/**
 * PATCH /order/bulk-payment/:id/accept
 * Accept only the main entry; apply all allocations in one transaction (push payment with mainPaymentId to each order).
 */
export const acceptBulkPayment = catchAsync(async (req, res, next) => {
  const { id } = req.params;
  const bulkId = new mongoose.Types.ObjectId(id);

  const bulk = await BulkPayment.findById(bulkId);
  if (!bulk) return next(new AppError("Bulk payment not found", 404));
  if (bulk.paymentStatus === "ACCEPTED") {
    return res.status(409).json({
      status: "fail",
      message: "Bulk payment already accepted",
    });
  }

  const session = await mongoose.startSession();
  session.startTransaction();
  const plantOrderIdsForWati = [];

  try {
    const mainPaymentId = bulk._id;
    const paymentPayload = {
      paidAmount: 0,
      paymentStatus: "COLLECTED",
      paymentDate: bulk.paymentDate,
      bankName: bulk.bankName,
      receiptPhoto: bulk.receiptPhoto || [],
      modeOfPayment: bulk.modeOfPayment,
      remark: bulk.remark || "",
      transactionId: bulk.transactionId,
      isWalletPayment: false,
      mainPaymentId,
    };

    const userId = req.user?._id || req.user?.id;

    for (const alloc of bulk.allocations) {
      paymentPayload.paidAmount = alloc.amount;

      if (alloc.orderType === "AgriSalesOrder") {
        const agriOrder = await AgriSalesOrder.findById(alloc.orderId).session(session);
        if (!agriOrder) throw new AppError(`AgriSalesOrder not found: ${alloc.orderId}`, 400);
        if (!agriOrder.payment) agriOrder.payment = [];
        agriOrder.payment.push({ ...paymentPayload });
        agriOrder.totalPaidAmount = (agriOrder.totalPaidAmount || 0) + alloc.amount;
        if ((agriOrder.totalPaidAmount || 0) >= (agriOrder.totalAmount || 0)) {
          agriOrder.paymentStatus = "COMPLETED";
        } else {
          agriOrder.paymentStatus = "PARTIAL";
        }
        await agriOrder.save({ session });

        if (shouldLogRamAgriLedger(agriOrder)) {
          const lastPayment = agriOrder.payment[agriOrder.payment.length - 1];
          await createCustomerLedgerEntry(
            {
              customerMobile: agriOrder.customerMobile,
              customerName: agriOrder.customerName,
              refType: "PAYMENT",
              refId: lastPayment._id,
              orderId: agriOrder._id,
              paymentId: lastPayment._id,
              credit: alloc.amount,
              reference: agriOrder.orderNumber,
              category: "Payment",
              description: `Payment via ${bulk.modeOfPayment || "N/A"} (bulk)`,
              entryDate: bulk.paymentDate || new Date(),
              createdBy: userId,
              metadata: { bulkPaymentId: mainPaymentId.toString() },
              session,
            }
          );
        }
      } else {
        const order = await Order.findById(alloc.orderId)
          .populate("farmer", "name village mobileNumber")
          .populate("plantName", "name")
          .session(session);
        if (!order) throw new AppError(`Order not found: ${alloc.orderId}`, 400);
        order.payment.push({ ...paymentPayload });
        await order.save({ session });

        if (!order.dealerOrder && order.farmer) {
          await ensureFarmerPlantOrderDebit(order, { userId, session });
          const lastPayment = order.payment[order.payment.length - 1];
          await recordFarmerPlantLedgerPaymentTransition(order, lastPayment, "PENDING", "COLLECTED", {
            userId,
            session,
          });
        }

        let dealerId = order.dealer;
        if (!dealerId && order.salesPerson) {
          const salesPerson = await User.findById(order.salesPerson).session(session);
          if (salesPerson && salesPerson.jobTitle === "DEALER") dealerId = salesPerson._id;
        }
        if (dealerId) {
          const farmerInfo = order.dealerOrder
            ? "Dealer Order"
            : order.farmer
              ? `${order.farmer.name || "Unknown"} (${order.farmer.village || ""})`
              : "Unknown";
          const description = `Payment collected for Order #${order._id} via ${bulk.modeOfPayment} (bulk) - ${farmerInfo}`;
          await DealerWallet.addPayment(
            dealerId,
            alloc.amount,
            description,
            userId,
            "ORDER_PAYMENT",
            order._id,
            session
          );
        }

        if (isBananaPlantName(order.plantName?.name || "")) {
          plantOrderIdsForWati.push(order._id);
        }
      }
    }

    bulk.paymentStatus = "ACCEPTED";
    bulk.acceptedAt = new Date();
    bulk.acceptedBy = userId;
    await bulk.save({ session });

    await session.commitTransaction();
  } catch (err) {
    await session.abortTransaction();
    throw err;
  } finally {
    session.endSession();
  }

  for (const oid of plantOrderIdsForWati) {
    void tryAutoSendOrderAcceptedWhatsApp(oid);
  }

  const updated = await BulkPayment.findById(bulkId)
    .populate("acceptedBy", "name phoneNumber")
    .lean();
  const response = generateResponse("Success", "Bulk payment accepted and allocations applied.", updated);
  res.status(200).json(response);
});

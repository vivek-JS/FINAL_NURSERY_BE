import mongoose from "mongoose";
import AppError from "../utility/appError.js";
import Order from "../models/order.model.js";
import AgriSalesOrder from "../models/agriSalesOrder.model.js";
import { isGiftInventoryCategory } from "../utils/linkedDispatchLoad.util.js";
import {
  findGiftProductById,
  listGiftProductsInStock,
  resolveGiftProductRate,
} from "./giftProductResolve.service.js";
import { createCustomerLedgerEntry } from "../utils/ramAgriLedgerHelper.js";

function logAgriActivity(order, entry) {
  if (!Array.isArray(order.activityLog)) order.activityLog = [];
  order.activityLog.push({
    ...entry,
    timestamp: new Date(),
  });
}

async function resolveNurseryOrderCustomer(nurseryOrder) {
  const farmer = nurseryOrder.farmer || {};
  const orderFor = nurseryOrder.orderFor || {};
  const customerMobile =
    String(farmer.mobileNumber || farmer.mobile || orderFor.mobileNumber || "").trim() ||
    String(nurseryOrder.whatsappBookingMobile || "").trim() ||
    (nurseryOrder._id ? `ORDER-${String(nurseryOrder._id).slice(-10)}` : "");
  if (!customerMobile) {
    throw new AppError(
      "Linked nursery order has no customer mobile — add farmer mobile or order contact",
      400
    );
  }
  return {
    customerMobile,
    customerName:
      String(farmer.name || orderFor.name || "").trim() || "Nursery Customer",
    customerVillage: String(farmer.village || orderFor.village || "").trim(),
    customerTaluka: String(farmer.taluka || orderFor.taluka || "").trim(),
    customerDistrict: String(farmer.district || orderFor.district || "").trim(),
    customerState: String(farmer.state || orderFor.state || "Maharashtra").trim(),
  };
}

export async function createLinkedGiftOrderForNursery({
  nurseryOrderId,
  productId,
  quantity,
  rate,
  notes = "",
  userId,
  salesPersonId,
  performedByName = "Unknown",
}) {
  if (!mongoose.isValidObjectId(String(nurseryOrderId))) {
    throw new AppError("Valid linked nursery order ID is required", 400);
  }
  if (!mongoose.isValidObjectId(String(productId))) {
    throw new AppError("Valid gift product ID is required", 400);
  }
  const numericQuantity = Number(quantity);
  if (Number.isNaN(numericQuantity) || numericQuantity <= 0) {
    throw new AppError("Quantity must be greater than 0", 400);
  }

  const resolved = await findGiftProductById(productId, { populateUnit: true });
  if (!resolved?.product || resolved.product.isActive === false) {
    throw new AppError("Gift product not found or inactive", 404);
  }
  if (!isGiftInventoryCategory(resolved.product.category)) {
    throw new AppError("Only gift category products can be linked to dispatch orders", 400);
  }

  const stockAvailable = Number(resolved.product.currentStock) || 0;
  if (stockAvailable < numericQuantity) {
    throw new AppError(
      `Insufficient stock for ${resolved.product.name}. Available: ${stockAvailable}, Required: ${numericQuantity}`,
      400
    );
  }

  const nurseryOrder = await Order.findById(nurseryOrderId)
    .select("orderId deliveryDate orderFor whatsappBookingMobile farmer")
    .populate("farmer", "name mobileNumber village taluka district state");
  if (!nurseryOrder) {
    throw new AppError("Linked nursery order not found", 404);
  }

  const customer = await resolveNurseryOrderCustomer(nurseryOrder);
  const linkedOrderCode = String(nurseryOrder.orderId || nurseryOrder._id);
  const { product } = resolved;

  const existing = await AgriSalesOrder.findOne({
    linkedNurseryOrderId: nurseryOrder._id,
    productId: product._id,
    isRamAgriProduct: { $ne: true },
    orderStatus: { $nin: ["CANCELLED", "REJECTED"] },
    agriLoadStatus: { $in: ["PENDING_LOAD", "LOADED"] },
  }).lean();
  if (existing) {
    return { skipped: true, order: existing, reason: "already_linked" };
  }

  const resolvedRate = resolveGiftProductRate(product, rate);
  if (Number.isNaN(resolvedRate) || resolvedRate <= 0) {
    throw new AppError("Rate is required for gift product", 400);
  }

  const totalAmount = numericQuantity * resolvedRate;
  const orderPayload = {
    customerName: customer.customerName,
    customerMobile: customer.customerMobile,
    customerVillage: customer.customerVillage,
    customerTaluka: customer.customerTaluka,
    customerDistrict: customer.customerDistrict,
    customerState: customer.customerState,
    isRamAgriProduct: false,
    productId: product._id,
    productName: product.name,
    primaryUnit: product.primaryUnit?._id || null,
    conversionFactor: product.conversionFactor || 1,
    quantity: numericQuantity,
    rate: resolvedRate,
    totalAmount,
    lineItems: [
      {
        isRamAgriProduct: false,
        productId: product._id,
        productName: product.name,
        primaryUnit: product.primaryUnit?._id || null,
        conversionFactor: product.conversionFactor || 1,
        quantity: numericQuantity,
        rate: resolvedRate,
      },
    ],
    orderDate: new Date(),
    deliveryDate: nurseryOrder.deliveryDate || null,
    notes: notes || "",
    createdBy: userId,
    salesPerson: salesPersonId,
    orderStatus: "ACCEPTED",
    acceptedBy: userId,
    acceptedAt: new Date(),
    linkedNurseryOrderId: nurseryOrder._id,
    linkedNurseryOrderCode: linkedOrderCode,
    agriLoadStatus: "PENDING_LOAD",
  };

  const order = await AgriSalesOrder.create(orderPayload);
  logAgriActivity(order, {
    action: "ORDER_CREATED",
    description: `Linked gift order created for nursery order #${linkedOrderCode} (${order.productName}).`,
    performedBy: userId,
    performedByName,
    metadata: {
      linkedNurseryOrderId: nurseryOrder._id,
      linkedNurseryOrderCode: linkedOrderCode,
      agriLoadStatus: "PENDING_LOAD",
      giftProduct: true,
    },
  });
  await order.save();

  await createCustomerLedgerEntry({
    customerMobile: order.customerMobile,
    customerName: order.customerName,
    refType: "ORDER",
    refId: order._id,
    orderId: order._id,
    debit: order.totalAmount || totalAmount,
    reference: order.orderNumber,
    category: "Order",
    description: `Linked gift for nursery order #${linkedOrderCode}`,
    entryDate: order.orderDate || order.createdAt,
    createdBy: userId,
    metadata: {
      linkedNurseryOrderId: nurseryOrder._id,
      linkedNurseryOrderCode: linkedOrderCode,
      productId: product._id,
    },
  });

  return { skipped: false, order };
}

export async function syncDispatchOrderGiftLines({ lines = [], userId, salesPersonId, performedByName }) {
  if (!Array.isArray(lines) || !lines.length) {
    return { created: [], skipped: [] };
  }

  const created = [];
  const skipped = [];

  for (const row of lines) {
    const nurseryOrderId = row?.nurseryOrderId || row?.linkedNurseryOrderId || row?.orderId;
    const productId = row?.productId;
    const quantity = row?.quantity;
    const rate = row?.rate;
    const notes = row?.notes || "";

    try {
      const result = await createLinkedGiftOrderForNursery({
        nurseryOrderId,
        productId,
        quantity,
        rate,
        notes,
        userId,
        salesPersonId,
        performedByName,
      });
      if (result.skipped) skipped.push({ nurseryOrderId, productId, order: result.order });
      else created.push(result.order);
    } catch (err) {
      throw err;
    }
  }

  return { created, skipped };
}

export { listGiftProductsInStock };

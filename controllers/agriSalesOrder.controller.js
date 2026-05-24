import catchAsync from "../utility/catchAsync.js";
import AppError from "../utility/appError.js";
import generateResponse from "../utility/responseFormat.js";
import APIFeatures from "../utility/apiFeatures.js";
import AgriSalesOrder, {
  getAgriOrderLines,
  distributeReturnQtyAcrossLines,
  computeAgriReturnCreditAmount,
} from "../models/agriSalesOrder.model.js";
import { InventoryProduct, InventoryOutwardTransaction, StockAdjustment } from "../models/inventory.model.js";
import RamAgriInputsProduct from "../models/ramAgriInputsProduct.model.js";
import Order from "../models/order.model.js";
import Farmer from "../models/farmer.model.js";
import Vehicle from "../models/vehicleModel.model.js";
import User from "../models/user.model.js";
import mongoose from "mongoose";
import { createCustomerLedgerEntry } from "../utils/ramAgriLedgerHelper.js";
import { generateQR } from "../services/iciciBankService.js";
import { normalizeIciciError, saveIciciQrAuditRecord } from "../services/iciciQr.service.js";
import {
  assertOutstandingAllowsNewExposure,
  assertOutstandingAllowsOrderUpdate,
  getEffectiveOutstandingLimitRupees,
  getOrCreateRamAgriSalesConfig,
  getOutstandingSummaryForSalesUser,
  orderRequiresRamAgriOutstandingLimit,
  projectProvisionalBalanceAmount,
  setGlobalDefaultOutstandingLimitRupees,
} from "../services/ramAgriOutstanding.service.js";
import {
  getAgriLoadWhitelist,
  normalizePhoneForWhitelist,
} from "../utils/agriLoadLinkSigner.js";

/** Ram Agri: customer ledger exists, but there is no order-to-order payment transfer API (farmer plant only). */

const shouldLogRamAgriLedger = (order) => {
  const lines = order?.lineItems;
  if (Array.isArray(lines) && lines.length > 0) {
    return lines.some((l) => l?.isRamAgriProduct || l?.ramAgriCropId || l?.ramAgriVarietyId);
  }
  return Boolean(order?.isRamAgriProduct || order?.ramAgriCropId || order?.ramAgriVarietyId);
};

/** Populate product refs on root and on each `lineItems` entry when present. */
async function populateAgriSalesOrderProductRefs(order) {
  if (!order) return;
  const hasLines = Array.isArray(order.lineItems) && order.lineItems.length > 0;
  if (hasLines) {
    await order.populate([
      { path: "lineItems.productId" },
      { path: "lineItems.ramAgriCropId" },
      { path: "lineItems.primaryUnit" },
      { path: "lineItems.secondaryUnit" },
    ]);
  }
  if (!order.isRamAgriProduct) {
    await order.populate("productId");
  } else {
    await order.populate("ramAgriCropId");
    await order.populate("primaryUnit");
    await order.populate("secondaryUnit");
  }
}

/** Build validated line item documents for create (throws AppError). */
async function buildAgriLineItemsForCreate(rawLines, orderDate) {
  const od = orderDate ? new Date(orderDate) : new Date();
  const normalized = [];
  for (let i = 0; i < rawLines.length; i++) {
    const row = rawLines[i] || {};
    const isRam = Boolean(row.isRamAgriProduct);
    const qty = Number(row.quantity);
    if (Number.isNaN(qty) || qty <= 0) {
      throw new AppError(`Line ${i + 1}: quantity must be greater than 0`, 400);
    }
    let rate = Number(row.rate);
    if (isRam) {
      const ramAgriCropId = row.ramAgriCropId;
      const ramAgriVarietyId = row.ramAgriVarietyId;
      if (!ramAgriCropId || !ramAgriVarietyId) {
        throw new AppError(`Line ${i + 1}: Crop ID and Variety ID are required for Ram Agri products`, 400);
      }
      if (!mongoose.isValidObjectId(ramAgriCropId) || !mongoose.isValidObjectId(ramAgriVarietyId)) {
        throw new AppError(`Line ${i + 1}: Invalid Crop ID or Variety ID format`, 400);
      }
      const crop = await RamAgriInputsProduct.findById(ramAgriCropId)
        .populate("varieties.primaryUnit", "name abbreviation")
        .populate("varieties.secondaryUnit", "name abbreviation");
      if (!crop) throw new AppError(`Line ${i + 1}: Crop not found`, 404);
      const variety = crop.varieties.id(ramAgriVarietyId);
      if (!variety) throw new AppError(`Line ${i + 1}: Variety not found`, 404);
      if (!variety.isActive) throw new AppError(`Line ${i + 1}: This variety is not active`, 400);
      let resolvedRate = rate;
      if (Number.isNaN(resolvedRate) || resolvedRate <= 0) {
        resolvedRate = resolveRamAgriRateForDate(variety, od);
      }
      if (Number.isNaN(resolvedRate) || resolvedRate <= 0) {
        throw new AppError(`Line ${i + 1}: Unable to resolve valid rate`, 400);
      }
      const secondaryUnitValue = variety.secondaryUnit?._id || row.secondaryUnit;
      normalized.push({
        sortOrder: i,
        isRamAgriProduct: true,
        productId: null,
        ramAgriCropId,
        ramAgriVarietyId,
        ramAgriCropName: row.ramAgriCropName || crop.cropName,
        ramAgriVarietyName: row.ramAgriVarietyName || variety.name,
        primaryUnit: variety.primaryUnit?._id || row.primaryUnit,
        secondaryUnit: secondaryUnitValue && secondaryUnitValue !== "" ? secondaryUnitValue : null,
        conversionFactor: variety.conversionFactor || row.conversionFactor || 1,
        productName: `${crop.cropName} - ${variety.name}`,
        quantity: qty,
        rate: resolvedRate,
        lineTotal: qty * resolvedRate,
      });
    } else {
      const productId = row.productId;
      if (!productId || !mongoose.isValidObjectId(productId)) {
        throw new AppError(`Line ${i + 1}: Product ID is required for regular products`, 400);
      }
      const product = await InventoryProduct.findById(productId);
      if (!product) throw new AppError(`Line ${i + 1}: Product not found`, 404);
      if (!product.isAgriSales) {
        throw new AppError(`Line ${i + 1}: Product is not available for Agri Sales orders`, 400);
      }
      if (Number.isNaN(rate) || rate <= 0) {
        throw new AppError(`Line ${i + 1}: Rate is required for regular products`, 400);
      }
      const unit = row.unit || product.unit || "pieces";
      normalized.push({
        sortOrder: i,
        isRamAgriProduct: false,
        productId,
        ramAgriCropId: null,
        ramAgriVarietyId: null,
        ramAgriCropName: "",
        ramAgriVarietyName: "",
        primaryUnit: null,
        secondaryUnit: null,
        conversionFactor: 1,
        productName: product.name,
        quantity: qty,
        unit,
        rate,
        lineTotal: qty * rate,
      });
    }
  }
  return normalized;
}

const resolveRamAgriRateForDate = (variety, dateValue = new Date()) => {
  if (!variety) return 0;
  const defaultRate = Number(variety.defaultRate || 0);
  const now = new Date(dateValue || new Date());
  const rates = Array.isArray(variety.rates) ? variety.rates : [];

  const activeRate = rates.find((rateEntry) => {
    if (!rateEntry?.startDate || !rateEntry?.endDate) return false;
    const start = new Date(rateEntry.startDate);
    const end = new Date(rateEntry.endDate);
    return now >= start && now <= end;
  });

  if (!activeRate) return defaultRate;

  const minRate = Number(activeRate.minRate);
  const maxRate = Number(activeRate.maxRate);
  if (!Number.isNaN(minRate) && !Number.isNaN(maxRate) && minRate >= 0 && maxRate >= 0) {
    return (minRate + maxRate) / 2;
  }

  const directRate = Number(activeRate.rate);
  if (!Number.isNaN(directRate) && directRate >= 0) return directRate;
  return defaultRate;
};

/** Ram Agri back-office (credit limits, linked load, etc.) — scoped to Ram Agri, not full nursery OFFICE_ADMIN. */
const RAM_AGRI_SALES_OFFICE_MANAGER = "RAM_AGRI_SALES_OFFICE_MANAGER";

const isRamAgriSalesOfficeManager = (user) => {
  const jt = String(user?.jobTitle || "").toUpperCase().trim();
  const r = String(user?.role || "").toUpperCase().trim();
  return jt === RAM_AGRI_SALES_OFFICE_MANAGER || r === RAM_AGRI_SALES_OFFICE_MANAGER;
};

/** Same wide Ram Agri views/filters as RAM_AGRI_SALES_MANAGER (analytics, assigned list). */
const isRamAgriSalesProgramLead = (user) => {
  const jt = String(user?.jobTitle || "").toUpperCase().trim();
  const r = String(user?.role || "").toUpperCase().trim();
  return (
    jt === "RAM_AGRI_SALES_MANAGER" ||
    r === "RAM_AGRI_SALES_MANAGER" ||
    isRamAgriSalesOfficeManager(user)
  );
};

const isRamAgriLoadAdmin = (user) => {
  const role = String(user?.role || "").toUpperCase();
  const jobTitle = String(user?.jobTitle || "").toUpperCase();
  return (
    role === "SUPER_ADMIN" ||
    role === "ADMIN" ||
    role === "RAM_AGRI_SALES_MANAGER" ||
    jobTitle === "RAM_AGRI_SALES_MANAGER" ||
    isRamAgriSalesOfficeManager(user)
  );
};

const isRamAgriSalesRep = (user) => {
  const jt = String(user?.jobTitle || "").toUpperCase().trim();
  const role = String(user?.role || "").toUpperCase().trim();
  return jt === "RAM_AGRI_SALES" || role === "RAM_AGRI_SALES" || jt === "SALES" || role === "SALES";
};

const isEligibleAgriSalesPerson = (userLike) => {
  const jt = String(userLike?.jobTitle || "").toUpperCase().trim();
  const role = String(userLike?.role || "").toUpperCase().trim();
  return jt === "RAM_AGRI_SALES" || role === "RAM_AGRI_SALES" || jt === "SALES" || role === "SALES";
};

/** Field rep → always self; others → body.salesPerson must be RAM_AGRI_SALES or SALES user. */
const resolveAgriOrderSalesPersonId = async (req, bodySalesPerson) => {
  const user = req.user;
  const userId = user?._id || user?.id;
  if (!userId) {
    throw new AppError("User authentication required", 401);
  }
  if (isRamAgriSalesRep(user)) {
    return userId;
  }
  const spRaw = bodySalesPerson;
  if (!spRaw || !mongoose.isValidObjectId(spRaw)) {
    throw new AppError("Sales person is required", 400);
  }
  const spUser = await User.findById(spRaw).select("jobTitle role");
  if (!spUser) {
    throw new AppError("Sales person not found", 404);
  }
  const spJt = String(spUser.jobTitle || "").toUpperCase().trim();
  const spRole = String(spUser.role || "").toUpperCase().trim();
  if (!isEligibleAgriSalesPerson({ jobTitle: spJt, role: spRole })) {
    throw new AppError("Selected user must be Ram Agri sales or Sales", 400);
  }
  return spRaw;
};

/** Restore Ram Agri / inventory stock for every line (reject/cancel after dispatch deduction). */
async function restoreStockForAgriOrder(order, notesSuffix, userId) {
  const lines = getAgriOrderLines(order);
  for (const line of lines) {
    const qty = Number(line.quantity) || 0;
    const rate = Number(line.rate) || 0;
    if (qty <= 0) continue;

    if (line.isRamAgriProduct || line.ramAgriCropId) {
      const crop = await RamAgriInputsProduct.findById(line.ramAgriCropId);
      if (!crop) continue;
      const variety = crop.varieties.id(line.ramAgriVarietyId);
      if (!variety) continue;
      variety.currentStock = (variety.currentStock || 0) + qty;
      variety.stockValue = (variety.stockValue || 0) + qty * rate;
      if (variety.currentStock > 0) {
        variety.averagePrice = variety.stockValue / variety.currentStock;
      } else {
        variety.averagePrice = 0;
      }
      await crop.save();
    } else if (line.productId) {
      await StockAdjustment.create({
        productId: line.productId,
        adjustmentType: "addition",
        quantity: qty,
        reason: "other",
        adjustedBy: userId,
        notes: `${notesSuffix}`,
      });
      const product = await InventoryProduct.findById(line.productId);
      if (product) {
        product.currentStock += qty;
        await product.save();
      }
    }
  }
}

/**
 * Deduct warehouse stock for each line on dispatch (admin direct only).
 * Returns { ok: true } or { ok: false, error: AppError }
 */
async function deductStockForAgriOrderLines(order, orderNumber, userId) {
  const lines = getAgriOrderLines(order);
  for (const line of lines) {
    const qty = Number(line.quantity) || 0;
    const rate = Number(line.rate) || 0;
    if (qty <= 0) continue;

    if (line.isRamAgriProduct || line.ramAgriCropId) {
      const crop = await RamAgriInputsProduct.findById(line.ramAgriCropId);
      if (!crop) continue;
      const variety = crop.varieties.id(line.ramAgriVarietyId);
      if (!variety) continue;
      const stockBefore = variety.currentStock || 0;
      if (stockBefore < qty) {
        return {
          ok: false,
          error: new AppError(
            `Insufficient stock for order ${orderNumber} (${line.productName || "item"}). Available: ${stockBefore}, Required: ${qty}`,
            400
          ),
        };
      }
      const svBefore = Number(variety.stockValue) || 0;
      variety.currentStock = stockBefore - qty;
      // Reduce carrying value by the same fraction of units removed — do not use qty×sale rate,
      // or stockValue can go negative when DB value is out of sync with units (legacy / manual stock).
      variety.stockValue =
        stockBefore > 0 ? Math.max(0, (svBefore * variety.currentStock) / stockBefore) : 0;
      if (variety.currentStock > 0) {
        variety.averagePrice = Math.max(0, variety.stockValue / variety.currentStock);
      } else {
        variety.averagePrice = 0;
      }
      await crop.save();
    } else if (line.productId) {
      const product = await InventoryProduct.findById(line.productId);
      if (!product) continue;
      const stockBefore = product.currentStock || 0;
      if (stockBefore < qty) {
        return {
          ok: false,
          error: new AppError(
            `Insufficient stock for order ${orderNumber} (${line.productName || "item"}). Available: ${stockBefore}, Required: ${qty}`,
            400
          ),
        };
      }
      product.currentStock = stockBefore - qty;
      await product.save();
      await InventoryOutwardTransaction.create({
        productId: line.productId,
        quantity: qty,
        sellingPrice: rate,
        totalAmount: qty * rate,
        customer: {
          name: order.customerName,
          contact: order.customerMobile,
        },
        purpose: "sale",
        destination: "customer",
        outwardDate: new Date(),
        issuedBy: userId,
        notes: `Ram Agri Sales Order: ${orderNumber} (Dispatched)`,
        status: "issued",
      });
    }
  }
  return { ok: true };
}

const normalizeAgriOrderSalesPerson = (orderDoc) => {
  if (!orderDoc) return orderDoc;
  const order = typeof orderDoc.toObject === "function" ? orderDoc.toObject() : { ...orderDoc };
  if (!Object.prototype.hasOwnProperty.call(order, "salesPerson")) {
    order.salesPerson = null;
  }
  if (
    !order.salesPerson &&
    order.createdBy &&
    typeof order.createdBy === "object" &&
    ["RAM_AGRI_SALES", "SALES"].includes(String(order.createdBy.jobTitle || order.createdBy.role || "").toUpperCase())
  ) {
    order.salesPerson = order.createdBy;
  }
  return order;
};

// ==================== CREATE AGRI SALES ORDER ====================

const createAgriSalesOrder = catchAsync(async (req, res, next) => {
  const {
    customerName,
    customerMobile,
    customerVillage,
    customerTaluka,
    customerDistrict,
    customerState,
    productId,
    isRamAgriProduct,
    ramAgriCropId,
    ramAgriVarietyId,
    ramAgriCropName,
    ramAgriVarietyName,
    primaryUnit,
    secondaryUnit,
    conversionFactor,
    quantity,
    rate,
    orderDate,
    deliveryDate,
    notes,
    payment,
    screenshots,
    salesPerson: salesPersonBody,
    lineItems: rawLineItems,
  } = req.body;

  const useMultiLine = Array.isArray(rawLineItems) && rawLineItems.length > 0;

  if (!customerName || !customerMobile) {
    return next(new AppError("Customer name and mobile are required", 400));
  }

  if (!useMultiLine && (quantity === undefined || quantity === null || quantity === "")) {
    return next(new AppError("Customer name, mobile, and quantity are required", 400));
  }

  if (customerMobile.length !== 10 || !/^\d{10}$/.test(customerMobile)) {
    return next(new AppError("Mobile number must be exactly 10 digits", 400));
  }

  let normalizedLines = null;
  let productName = "";
  let resolvedRate = Number(rate);
  let totalAmount = 0;
  let crop = null;
  let variety = null;

  if (useMultiLine) {
    try {
      normalizedLines = await buildAgriLineItemsForCreate(rawLineItems, orderDate);
    } catch (e) {
      return next(e instanceof AppError ? e : new AppError(e.message || "Invalid line items", 400));
    }
    totalAmount = normalizedLines.reduce((s, l) => s + (l.lineTotal || 0), 0);
    productName = normalizedLines.map((l) => l.productName).join("; ");
  } else {
    let product = null;
    let unit = "";

    if (isRamAgriProduct) {
      if (!ramAgriCropId || !ramAgriVarietyId) {
        return next(new AppError("Crop ID and Variety ID are required for Ram Agri products", 400));
      }

      if (!mongoose.isValidObjectId(ramAgriCropId) || !mongoose.isValidObjectId(ramAgriVarietyId)) {
        return next(new AppError("Invalid Crop ID or Variety ID format", 400));
      }

      crop = await RamAgriInputsProduct.findById(ramAgriCropId)
        .populate("varieties.primaryUnit", "name abbreviation")
        .populate("varieties.secondaryUnit", "name abbreviation");

      if (!crop) {
        return next(new AppError("Crop not found", 404));
      }

      variety = crop.varieties.id(ramAgriVarietyId);
      if (!variety) {
        return next(new AppError("Variety not found", 404));
      }

      if (!variety.isActive) {
        return next(new AppError("This variety is not active", 400));
      }

      productName = `${crop.cropName} - ${variety.name}`;
      unit = variety.primaryUnit?.abbreviation || variety.primaryUnit?.name || "N/A";
      if (Number.isNaN(resolvedRate) || resolvedRate <= 0) {
        resolvedRate = resolveRamAgriRateForDate(variety, orderDate);
      }
    } else {
      if (!productId) {
        return next(new AppError("Product ID is required for regular products", 400));
      }

      if (!mongoose.isValidObjectId(productId)) {
        return next(new AppError("Invalid product ID format", 400));
      }

      product = await InventoryProduct.findById(productId);
      if (!product) {
        return next(new AppError("Product not found", 404));
      }

      if (!product.isAgriSales) {
        return next(new AppError("This product is not available for Agri Sales orders", 400));
      }

      productName = product.name;
      unit = product.unit || "N/A";
      if (Number.isNaN(resolvedRate) || resolvedRate <= 0) {
        return next(new AppError("Rate is required for regular products", 400));
      }
    }

    if (Number.isNaN(resolvedRate) || resolvedRate <= 0) {
      return next(new AppError("Unable to resolve valid rate for selected product", 400));
    }

    totalAmount = quantity * resolvedRate;
  }

  let processedPayments = [];
  let initialPaidAmount = 0;

  if (payment && Array.isArray(payment) && payment.length > 0) {
    processedPayments = payment.map((p) => ({
      paidAmount: p.paidAmount || 0,
      paymentStatus: p.paymentStatus || "PENDING",
      paymentDate: p.paymentDate ? new Date(p.paymentDate) : new Date(),
      bankName: p.bankName || "",
      transactionId: p.transactionId || "",
      receiptPhoto: p.receiptPhoto || [],
      modeOfPayment: p.modeOfPayment || (p.isWalletPayment ? "Wallet" : ""),
      remark: p.remark || "",
      isWalletPayment: p.isWalletPayment || false,
    }));

    initialPaidAmount = processedPayments
      .filter((p) => p.paymentStatus === "COLLECTED")
      .reduce((sum, p) => sum + (p.paidAmount || 0), 0);
  }

  let initialPaymentStatus = "PENDING";
  if (processedPayments.length > 0) {
    const totalPending = processedPayments.reduce((sum, p) => sum + (p.paidAmount || 0), 0);
    if (initialPaidAmount >= totalAmount) {
      initialPaymentStatus = "COMPLETED";
    } else if (initialPaidAmount > 0) {
      initialPaymentStatus = "PARTIAL";
    } else {
      initialPaymentStatus = "PENDING";
    }
  }

  const userId = req.user?._id || req.user?.id;
  if (!userId) {
    return next(new AppError("User authentication required. Please login to create orders.", 401));
  }

  const salesPersonId = await resolveAgriOrderSalesPersonId(req, salesPersonBody);

  const newExposure = Math.max(0, Math.round((totalAmount - initialPaidAmount) * 100) / 100);
  const needsRamAgriOutstandingLimit = useMultiLine
    ? normalizedLines.some((l) => l.isRamAgriProduct || l.ramAgriCropId)
    : Boolean(isRamAgriProduct);
  if (needsRamAgriOutstandingLimit && newExposure > 0) {
    await assertOutstandingAllowsNewExposure({
      salesPersonId,
      additionalExposureRupees: newExposure,
    });
  }

  let orderData;

  if (useMultiLine) {
    orderData = {
      customerName: customerName.trim(),
      customerMobile: customerMobile.trim(),
      customerVillage: customerVillage?.trim() || "",
      customerTaluka: customerTaluka?.trim() || "",
      customerDistrict: customerDistrict?.trim() || "",
      customerState: (customerState || "Maharashtra").trim(),
      lineItems: normalizedLines,
      orderDate: orderDate ? new Date(orderDate) : new Date(),
      deliveryDate:
        deliveryDate && deliveryDate !== "null" && deliveryDate !== null ? new Date(deliveryDate) : undefined,
      notes: notes?.trim() || "",
      payment: processedPayments,
      screenshots: screenshots || [],
      createdBy: userId,
      salesPerson: salesPersonId,
      orderStatus: "ACCEPTED",
      acceptedBy: userId,
      acceptedAt: new Date(),
      paymentStatus: initialPaymentStatus,
      totalPaidAmount: initialPaidAmount,
      balanceAmount: totalAmount - initialPaidAmount,
    };
  } else {
    orderData = {
      customerName: customerName.trim(),
      customerMobile: customerMobile.trim(),
      customerVillage: customerVillage?.trim() || "",
      customerTaluka: customerTaluka?.trim() || "",
      customerDistrict: customerDistrict?.trim() || "",
      customerState: (customerState || "Maharashtra").trim(),
      isRamAgriProduct: isRamAgriProduct || false,
      productName,
      quantity,
      rate: resolvedRate,
      totalAmount,
      orderDate: orderDate ? new Date(orderDate) : new Date(),
      deliveryDate:
        deliveryDate && deliveryDate !== "null" && deliveryDate !== null ? new Date(deliveryDate) : undefined,
      notes: notes?.trim() || "",
      payment: processedPayments,
      screenshots: screenshots || [],
      createdBy: userId,
      salesPerson: salesPersonId,
      orderStatus: "ACCEPTED",
      acceptedBy: userId,
      acceptedAt: new Date(),
      paymentStatus: initialPaymentStatus,
      totalPaidAmount: initialPaidAmount,
      balanceAmount: totalAmount - initialPaidAmount,
    };

    if (isRamAgriProduct) {
      orderData.ramAgriCropId = ramAgriCropId;
      orderData.ramAgriVarietyId = ramAgriVarietyId;
      orderData.ramAgriCropName = ramAgriCropName || crop.cropName;
      orderData.ramAgriVarietyName = ramAgriVarietyName || variety.name;
      orderData.primaryUnit = variety.primaryUnit?._id || primaryUnit;
      const secondaryUnitValue = variety.secondaryUnit?._id || secondaryUnit;
      orderData.secondaryUnit = secondaryUnitValue && secondaryUnitValue !== "" ? secondaryUnitValue : null;
      orderData.conversionFactor = variety.conversionFactor || conversionFactor || 1;
      orderData.productId = null;
    } else {
      orderData.productId = productId;
      orderData.unit = unit;
      orderData.ramAgriCropId = null;
      orderData.ramAgriVarietyId = null;
    }
  }

  const order = await AgriSalesOrder.create(orderData);

  if (shouldLogRamAgriLedger(order)) {
    await createCustomerLedgerEntry({
      customerMobile: order.customerMobile,
      customerName: order.customerName,
      refType: "ORDER",
      refId: order._id,
      orderId: order._id,
      debit: order.totalAmount || totalAmount,
      reference: order.orderNumber,
      category: "Order",
      description: `Order created for ${useMultiLine ? productName : order.ramAgriCropName || productName}`,
      entryDate: order.orderDate || order.createdAt,
      createdBy: userId,
      metadata: {
        cropId: order.ramAgriCropId,
        varietyId: order.ramAgriVarietyId,
        lineCount: useMultiLine ? normalizedLines.length : 1,
        customerVillage: order.customerVillage,
        customerTaluka: order.customerTaluka,
        customerDistrict: order.customerDistrict,
      },
    });
  }

  const qtyLabel = useMultiLine ? normalizedLines.reduce((s, l) => s + l.quantity, 0) : quantity;
  const rateLabel = useMultiLine ? "multiple" : resolvedRate;

  order.activityLog = [
    {
      action: "ORDER_CREATED",
      description: useMultiLine
        ? `Order created and auto-accepted for ${customerName} — ${normalizedLines.length} product line(s): ${productName}. Status: ACCEPTED — ready for assign or dispatch.`
        : `Order created and auto-accepted for ${customerName} - ${productName} (Qty: ${quantity}, Rate: ₹${resolvedRate}). Status: ACCEPTED — ready for assign or dispatch.`,
      performedBy: userId,
      performedByName: req.user?.name || "Unknown",
      newValue: {
        customerName,
        customerMobile,
        productName: order.productName,
        quantity: qtyLabel,
        rate: rateLabel,
        totalAmount: order.totalAmount,
        orderStatus: "ACCEPTED",
        lineCount: useMultiLine ? normalizedLines.length : 1,
      },
      metadata: {
        orderNumber: order.orderNumber,
      },
    },
  ];

  if (processedPayments.length > 0) {
    processedPayments.forEach((p) => {
      order.activityLog.push({
        action: "PAYMENT_ADDED",
        description: `Payment of ₹${p.paidAmount} added via ${p.modeOfPayment}`,
        performedBy: userId,
        performedByName: req.user?.name || "Unknown",
        newValue: {
          paidAmount: p.paidAmount,
          modeOfPayment: p.modeOfPayment,
          paymentStatus: p.paymentStatus,
        },
      });
    });
  }

  await order.save();

  // Create farmer from customer data if farmer doesn't exist
  try {
    console.log("🔍 Checking if farmer exists for customer mobile:", customerMobile);
    
    // Check if farmer already exists with this mobile number
    let customerFarmer = await Farmer.findOne({ 
      mobileNumber: customerMobile 
    });
    
    if (!customerFarmer) {
      console.log("✅ Farmer not found - Creating new farmer from agri sales order customer data");
      
      // Create new farmer with customer data from order
      const farmerData = {
        name: customerName.trim(),
        mobileNumber: customerMobile.trim(),
        village: customerVillage?.trim() || "To be updated",
        taluka: customerTaluka?.trim() || "To be updated",
        district: customerDistrict?.trim() || "To be updated",
        state: customerState?.trim() || "Maharashtra",
        stateName: customerState?.trim() || "Maharashtra",
        talukaName: customerTaluka?.trim() || "To be updated",
        districtName: customerDistrict?.trim() || "To be updated",
      };
      
      console.log("📝 Creating new farmer with data:", farmerData);
      
      // Create the farmer
      customerFarmer = await Farmer.create(farmerData);
      
      console.log("✅ Successfully created new farmer from agri sales order! ID:", customerFarmer._id, "Name:", customerFarmer.name);
    } else {
      console.log("ℹ️ Farmer already exists with mobile number:", customerMobile, "- Skipping creation");
    }
  } catch (error) {
    console.error("❌ Error creating farmer from agri sales order customer data:", error.message);
    console.error("Full error:", error);
    // Don't fail the order creation if farmer creation fails
  }

  if (shouldLogRamAgriLedger(order) && order.payment && Array.isArray(order.payment)) {
    const collectedPayments = order.payment.filter(
      (payment) => payment.paymentStatus === "COLLECTED"
    );
    for (const payment of collectedPayments) {
      await createCustomerLedgerEntry({
        customerMobile: order.customerMobile,
        customerName: order.customerName,
        refType: "PAYMENT",
        refId: payment._id,
        orderId: order._id,
        paymentId: payment._id,
        credit: payment.paidAmount || 0,
        reference: order.orderNumber,
        category: "Payment",
        description: `Payment via ${payment.modeOfPayment || "N/A"}`,
        entryDate: payment.paymentDate || order.orderDate || order.createdAt,
        createdBy: userId,
        metadata: {
          paymentStatus: payment.paymentStatus,
          modeOfPayment: payment.modeOfPayment,
        },
      });
    }
  }

  if (useMultiLine) {
    await order.populate([
      { path: "lineItems.productId" },
      { path: "lineItems.ramAgriCropId" },
      { path: "lineItems.primaryUnit" },
      { path: "lineItems.secondaryUnit" },
    ]);
  } else if (!isRamAgriProduct) {
    await order.populate("productId");
  } else {
    await order.populate("ramAgriCropId");
    await order.populate("primaryUnit");
    await order.populate("secondaryUnit");
  }
  await order.populate("createdBy");
  await order.populate("salesPerson", "name phoneNumber jobTitle");

  const response = generateResponse(
    "Success",
    "Agri Sales Order created successfully",
    order,
    undefined
  );

  return res.status(201).json(response);
});

const createLinkedAgriOrderFromNurseryOrder = catchAsync(async (req, res, next) => {
  const {
    linkedNurseryOrderId,
    ramAgriCropId,
    ramAgriVarietyId,
    quantity,
    rate,
    notes,
    salesPerson: linkedSalesPersonBody,
  } = req.body;

  if (!mongoose.isValidObjectId(linkedNurseryOrderId)) {
    return next(new AppError("Valid linked nursery order ID is required", 400));
  }
  if (!mongoose.isValidObjectId(ramAgriCropId) || !mongoose.isValidObjectId(ramAgriVarietyId)) {
    return next(new AppError("Valid crop and variety IDs are required", 400));
  }
  const numericQuantity = Number(quantity);
  if (Number.isNaN(numericQuantity) || numericQuantity <= 0) {
    return next(new AppError("Quantity must be greater than 0", 400));
  }

  const nurseryOrder = await Order.findById(linkedNurseryOrderId)
    .populate("farmer", "name mobileNumber village taluka district state");
  if (!nurseryOrder) {
    return next(new AppError("Linked nursery order not found", 404));
  }

  const crop = await RamAgriInputsProduct.findById(ramAgriCropId)
    .populate("varieties.primaryUnit", "name abbreviation")
    .populate("varieties.secondaryUnit", "name abbreviation");
  if (!crop) return next(new AppError("Crop not found", 404));

  const variety = crop.varieties.id(ramAgriVarietyId);
  if (!variety || variety.isActive === false) {
    return next(new AppError("Selected variety not found or inactive", 400));
  }

  let resolvedRate = Number(rate);
  if (Number.isNaN(resolvedRate) || resolvedRate <= 0) {
    resolvedRate = resolveRamAgriRateForDate(variety, nurseryOrder.deliveryDate || new Date());
  }
  if (Number.isNaN(resolvedRate) || resolvedRate <= 0) {
    return next(new AppError("Unable to resolve valid rate for selected variety", 400));
  }

  const farmer = nurseryOrder.farmer || {};
  const userId = req.user?._id || req.user?.id;
  if (!userId) return next(new AppError("User authentication required", 401));

  const salesPersonId = await resolveAgriOrderSalesPersonId(req, linkedSalesPersonBody);

  const totalAmount = numericQuantity * resolvedRate;
  const linkedOrderCode = String(nurseryOrder.orderId || nurseryOrder._id);

  const order = await AgriSalesOrder.create({
    customerName: String(farmer.name || "").trim() || "Nursery Customer",
    customerMobile: String(farmer.mobileNumber || "").trim(),
    customerVillage: String(farmer.village || "").trim(),
    customerTaluka: String(farmer.taluka || "").trim(),
    customerDistrict: String(farmer.district || "").trim(),
    customerState: String(farmer.state || "Maharashtra").trim(),
    isRamAgriProduct: true,
    ramAgriCropId,
    ramAgriVarietyId,
    ramAgriCropName: crop.cropName,
    ramAgriVarietyName: variety.name,
    primaryUnit: variety.primaryUnit?._id || null,
    secondaryUnit: variety.secondaryUnit?._id || null,
    conversionFactor: variety.conversionFactor || 1,
    productName: `${crop.cropName} - ${variety.name}`,
    quantity: numericQuantity,
    rate: resolvedRate,
    totalAmount,
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
  });

  if (!order.activityLog) order.activityLog = [];
  order.activityLog.push({
    action: "ORDER_CREATED",
    description: `Linked agri order created for nursery order #${linkedOrderCode} (${order.productName}).`,
    performedBy: userId,
    performedByName: req.user?.name || "Unknown",
    metadata: {
      linkedNurseryOrderId: nurseryOrder._id,
      linkedNurseryOrderCode: linkedOrderCode,
      agriLoadStatus: "PENDING_LOAD",
    },
  });
  await order.save();

  await order.populate("createdBy");
  await order.populate("salesPerson", "name phoneNumber jobTitle");

  await createCustomerLedgerEntry({
    customerMobile: order.customerMobile,
    customerName: order.customerName,
    refType: "ORDER",
    refId: order._id,
    orderId: order._id,
    debit: order.totalAmount || totalAmount,
    reference: order.orderNumber,
    category: "Order",
    description: `Linked order for nursery order #${linkedOrderCode}`,
    entryDate: order.orderDate || order.createdAt,
    createdBy: userId,
    metadata: {
      linkedNurseryOrderId: nurseryOrder._id,
      linkedNurseryOrderCode: linkedOrderCode,
      cropId: order.ramAgriCropId,
      varietyId: order.ramAgriVarietyId,
    },
  });

  const response = generateResponse(
    "Success",
    "Linked Agri order created successfully",
    order,
    undefined
  );
  return res.status(201).json(response);
});

const markLinkedAgriLoaded = catchAsync(async (req, res, next) => {
  if (!isRamAgriLoadAdmin(req.user)) {
    return next(new AppError("Only Agri Input admin can mark as loaded", 403));
  }

  const { id } = req.params;
  if (!mongoose.isValidObjectId(id)) {
    return next(new AppError("Invalid agri order ID format", 400));
  }

  const order = await AgriSalesOrder.findById(id);
  if (!order) return next(new AppError("Agri order not found", 404));
  if (!order.linkedNurseryOrderId) {
    return next(new AppError("This agri order is not linked to a nursery order", 400));
  }

  order.agriLoadStatus = "LOADED";
  order.loadedAt = new Date();
  order.loadedBy = req.user?._id || req.user?.id || null;
  if (!order.activityLog) order.activityLog = [];
  order.activityLog.push({
    action: "DISPATCH_UPDATED",
    description: `Agri load marked as LOADED by ${req.user?.name || "admin"}.`,
    performedBy: req.user?._id || req.user?.id,
    performedByName: req.user?.name || "Unknown",
    metadata: { agriLoadStatus: "LOADED", loadedAt: order.loadedAt },
  });
  await order.save();

  return res.status(200).json(
    generateResponse("Success", "Linked agri order marked as loaded", order, undefined)
  );
});

const markLinkedAgriLoadedViaLink = catchAsync(async (req, res, next) => {
  const { orderNumber, actorPhone } = req.query || {};
  const normalizedOrderNumber = String(orderNumber || "").trim().toUpperCase();
  const normalizedActorPhone = normalizePhoneForWhitelist(actorPhone || "");

  if (!normalizedOrderNumber) {
    return next(new AppError("orderNumber is required", 400));
  }
  const whitelist = new Set(getAgriLoadWhitelist());
  if (!normalizedActorPhone || !whitelist.has(normalizedActorPhone)) {
    console.warn("[Agri Load Link] denied (whitelist):", {
      orderNumber: normalizedOrderNumber,
      actorPhone: normalizedActorPhone,
      whitelistCount: whitelist.size,
    });
    return res
      .status(403)
      .type("text/html")
      .send("<h3>Not authorized for this action.</h3>");
  }

  const order = await AgriSalesOrder.findOne({ orderNumber: normalizedOrderNumber });
  if (!order) {
    return res.status(404).type("text/html").send("<h3>Agri order not found.</h3>");
  }
  if (!order.linkedNurseryOrderId) {
    return res
      .status(400)
      .type("text/html")
      .send("<h3>This agri order is not linked to nursery order.</h3>");
  }

  if (String(order.agriLoadStatus || "").toUpperCase() !== "LOADED") {
    const fallbackUser = await User.findOne({
      $or: [{ role: "SUPER_ADMIN" }, { jobTitle: "SUPER_ADMIN" }],
    })
      .select("_id name")
      .lean();
    if (!fallbackUser?._id) {
      return res
        .status(500)
        .type("text/html")
        .send("<h3>Cannot resolve audit user for one-click action.</h3>");
    }

    order.agriLoadStatus = "LOADED";
    order.loadedAt = new Date();
    order.loadedBy = fallbackUser._id;
    if (!order.activityLog) order.activityLog = [];
    order.activityLog.push({
      action: "DISPATCH_UPDATED",
      description: `Agri load marked as LOADED via one-click link by ${normalizedActorPhone}.`,
      performedBy: fallbackUser._id,
      performedByName: fallbackUser?.name || `LINK:${normalizedActorPhone}`,
      metadata: {
        agriLoadStatus: "LOADED",
        loadedAt: order.loadedAt,
        source: "WHATSAPP_ONE_CLICK",
        actorPhone: normalizedActorPhone,
      },
    });
    await order.save();
  }

  return res
    .status(200)
    .type("text/html")
    .send(`<h3>Success: ${order.orderNumber} marked as LOADED.</h3>`);
});

const getLinkedOrdersByNurseryOrder = catchAsync(async (req, res, next) => {
  const { orderId } = req.params;
  if (!mongoose.isValidObjectId(orderId)) {
    return next(new AppError("Invalid nursery order ID format", 400));
  }
  const orders = await AgriSalesOrder.find({ linkedNurseryOrderId: orderId })
    .sort({ createdAt: -1 })
    .lean();

  return res.status(200).json(
    generateResponse("Success", "Linked agri orders fetched successfully", orders, undefined)
  );
});

const getTodayPendingLinkedLoads = catchAsync(async (req, res) => {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const end = new Date();
  end.setHours(23, 59, 59, 999);

  const orders = await AgriSalesOrder.find({
    linkedNurseryOrderId: { $ne: null },
    agriLoadStatus: "PENDING_LOAD",
    orderDate: { $gte: start, $lte: end },
  })
    .sort({ createdAt: -1 })
    .populate("linkedNurseryOrderId", "orderId deliveryDate farmer")
    .lean();

  return res.status(200).json(
    generateResponse("Success", "Today's pending linked agri loads fetched", orders, undefined)
  );
});

/** Ram Agri row is "cleared" for nursery DC only when explicitly marked LOADED. */
const isLinkedAgriLoadSatisfied = (order) => {
  const load = String(order?.agriLoadStatus || "").toUpperCase();
  return load === "LOADED";
};

const getDispatchLoadStatus = catchAsync(async (req, res, next) => {
  const orderIds = Array.isArray(req.body?.orderIds) ? req.body.orderIds : [];
  if (!orderIds.length) {
    return next(new AppError("orderIds array is required", 400));
  }
  const normalizedIds = orderIds
    .filter((id) => mongoose.isValidObjectId(String(id)))
    .map((id) => new mongoose.Types.ObjectId(String(id)));
  if (!normalizedIds.length) {
    return next(new AppError("No valid order IDs provided", 400));
  }

  const linkedOrders = await AgriSalesOrder.find({
    linkedNurseryOrderId: { $in: normalizedIds },
    orderStatus: { $nin: ["CANCELLED", "REJECTED"] },
  }).lean();

  const blocking = linkedOrders.filter((order) => !isLinkedAgriLoadSatisfied(order));
  const responseData = {
    isBlocked: blocking.length > 0,
    blockedBy: blocking.map((order) => ({
      agriOrderId: order._id,
      agriOrderNumber: order.orderNumber,
      linkedNurseryOrderId: order.linkedNurseryOrderId,
      linkedNurseryOrderCode: order.linkedNurseryOrderCode || "",
      agriLoadStatus: order.agriLoadStatus || "PENDING_LOAD",
      dispatchStatus: order.dispatchStatus,
      orderStatus: order.orderStatus,
      customerName: order.customerName,
      productName: order.productName,
      quantity: order.quantity,
    })),
  };

  return res.status(200).json(
    generateResponse("Success", "Dispatch load status fetched", responseData, undefined)
  );
});

// ==================== ACCEPT ORDER (NO STOCK CHECK - Stock checked/deducted only on direct admin dispatch) ====================

const acceptAgriSalesOrder = catchAsync(async (req, res, next) => {
  const { id } = req.params;

  if (!mongoose.isValidObjectId(id)) {
    return next(new AppError("Invalid order ID format", 400));
  }

  const order = await AgriSalesOrder.findById(id);
  if (!order) {
    return next(new AppError("Order not found", 404));
  }

  // Allow accepting PENDING or ASSIGNED orders
  if (!["PENDING", "ASSIGNED"].includes(order.orderStatus)) {
    return next(new AppError(`Cannot accept order with status: ${order.orderStatus}`, 400));
  }

  // NO stock check on accept - stock will be checked only when admin dispatches directly
  // If order is assigned to sales person, no stock check/deduction happens at all

  const previousStatus = order.orderStatus;
  const previousAssignedTo = order.assignedTo;
  const previousAssignedBy = order.assignedBy;
  const previousAssignedAt = order.assignedAt;
  const previousAssignmentNotes = order.assignmentNotes;

  // Update order status (NO stock deduction - happens on direct admin dispatch only)
  order.orderStatus = "ACCEPTED";
  order.stockDeducted = false; // Stock will be deducted only on direct admin dispatch
  order.acceptedBy = req.user?._id || req.user?.id;
  order.acceptedAt = new Date();

  // If order was ASSIGNED, clear the assignment fields
  if (previousStatus === "ASSIGNED") {
    order.assignedTo = undefined;
    order.assignedBy = undefined;
    order.assignedAt = undefined;
    order.assignmentNotes = undefined;
  }

  // Add activity log
  if (!order.activityLog) order.activityLog = [];
  
  let description = `Order accepted. Status: ${previousStatus} → ACCEPTED. Stock will be checked/deducted only if admin dispatches directly.`;
  if (previousStatus === "ASSIGNED") {
    description += " Assignment cleared.";
  }

  const activityLogEntry = {
    action: "ORDER_ACCEPTED",
    description,
    performedBy: req.user?._id || req.user?.id,
    performedByName: req.user?.name || "Unknown",
    previousValue: { 
      orderStatus: previousStatus,
      ...(previousStatus === "ASSIGNED" ? {
        assignedTo: previousAssignedTo,
        assignedBy: previousAssignedBy,
        assignedAt: previousAssignedAt,
        assignmentNotes: previousAssignmentNotes,
      } : {}),
    },
    newValue: { 
      orderStatus: "ACCEPTED",
      ...(previousStatus === "ASSIGNED" ? {
        assignedTo: null,
        assignedBy: null,
        assignedAt: null,
        assignmentNotes: null,
      } : {}),
    },
    metadata: { 
      requiredQuantity: order.quantity,
      ...(previousStatus === "ASSIGNED" ? { assignmentCleared: true } : {}),
    },
  };

  order.activityLog.push(activityLogEntry);

  await order.save();

  // Populate fields
  await populateAgriSalesOrderProductRefs(order);
  await order.populate("createdBy");
  await order.populate("salesPerson", "name phoneNumber jobTitle");
  await order.populate("acceptedBy");

  const response = generateResponse(
    "Success",
    "Order accepted successfully. Stock will be deducted on dispatch.",
    order,
    undefined
  );

  return res.status(200).json(response);
});

// ==================== REJECT ORDER ====================

const rejectAgriSalesOrder = catchAsync(async (req, res, next) => {
  const { id } = req.params;
  const { reason } = req.body;

  if (!mongoose.isValidObjectId(id)) {
    return next(new AppError("Invalid order ID format", 400));
  }

  const order = await AgriSalesOrder.findById(id);
  if (!order) {
    return next(new AppError("Order not found", 404));
  }

  // Can reject PENDING orders, or cancel ACCEPTED/ASSIGNED orders
  if (!["PENDING", "ACCEPTED", "ASSIGNED"].includes(order.orderStatus)) {
    return next(new AppError(`Cannot reject order with status: ${order.orderStatus}`, 400));
  }

  // Store whether stock was deducted (before we update the order)
  const stockWasDeducted = order.stockDeducted && order.orderStatus === "ACCEPTED";

  // If order was ACCEPTED and stock was deducted, add stock back
  if (stockWasDeducted) {
    try {
      await restoreStockForAgriOrder(
        order,
        `Ram Agri Sales Order Rejected: ${order.orderNumber}. ${reason || "Order rejected"}`,
        req.user?._id || req.user?.id
      );
    } catch (stockErr) {
      return next(new AppError(`Failed to restore stock: ${stockErr.message}`, 500));
    }
  }

  // Store previous status for activity log
  const previousStatus = order.orderStatus;

  // Update order status
  order.orderStatus = "REJECTED";
  order.stockDeducted = false;
  order.stockDeductedAt = null;
  if (reason) {
    if (!order.remarks) order.remarks = [];
    order.remarks.push(`Rejected: ${reason}`);
  }

  // Add activity log
  if (!order.activityLog) order.activityLog = [];
  order.activityLog.push({
    action: "ORDER_REJECTED",
    description: `Order rejected${reason ? `: ${reason}` : ""}${stockWasDeducted ? " (stock restored)" : ""}`,
    performedBy: req.user?._id || req.user?.id,
    performedByName: req.user?.name || "Unknown",
    previousValue: { orderStatus: previousStatus, stockDeducted: stockWasDeducted },
    newValue: { orderStatus: "REJECTED", stockDeducted: false },
    metadata: { reason, stockRestored: stockWasDeducted },
  });

  await order.save();

  // Populate fields
  if (!order.isRamAgriProduct) {
    await order.populate("productId");
  } else {
    await order.populate("ramAgriCropId");
    await order.populate("primaryUnit");
    await order.populate("secondaryUnit");
  }
  await order.populate("createdBy");
  await order.populate("salesPerson", "name phoneNumber jobTitle");

  const response = generateResponse(
    "Success",
    stockWasDeducted ? "Order rejected and stock restored successfully" : "Order rejected successfully",
    order,
    undefined
  );

  return res.status(200).json(response);
});

// ==================== CANCEL ORDER ====================

const cancelAgriSalesOrder = catchAsync(async (req, res, next) => {
  const { id } = req.params;
  const { reason } = req.body;

  if (!mongoose.isValidObjectId(id)) {
    return next(new AppError("Invalid order ID format", 400));
  }

  const order = await AgriSalesOrder.findById(id);
  if (!order) {
    return next(new AppError("Order not found", 404));
  }

  // Can only cancel ACCEPTED orders
  if (order.orderStatus !== "ACCEPTED") {
    return next(new AppError(`Cannot cancel order with status: ${order.orderStatus}. Only ACCEPTED orders can be cancelled.`, 400));
  }

  // Store whether stock was deducted (before we update the order)
  const stockWasDeducted = order.stockDeducted;

  // If stock was deducted, add stock back
  if (stockWasDeducted) {
    try {
      await restoreStockForAgriOrder(
        order,
        `Ram Agri Sales Order Cancelled: ${order.orderNumber}. ${reason || "Order cancelled"}`,
        req.user?._id || req.user?.id
      );
    } catch (stockErr) {
      return next(new AppError(`Failed to restore stock: ${stockErr.message}`, 500));
    }
  }

  // Update order status
  order.orderStatus = "CANCELLED";
  order.stockDeducted = false;
  order.stockDeductedAt = null;
  if (reason) {
    if (!order.remarks) order.remarks = [];
    order.remarks.push(`Cancelled: ${reason}`);
  }
  await order.save();

  if (shouldLogRamAgriLedger(order)) {
    await createCustomerLedgerEntry({
      customerMobile: order.customerMobile,
      customerName: order.customerName,
      refType: "REVERSAL",
      refId: order._id,
      orderId: order._id,
      credit: order.totalAmount || 0,
      reference: order.orderNumber,
      category: "Order Reversal",
      description: `Order cancelled${reason ? `: ${reason}` : ""}`,
      entryDate: new Date(),
      createdBy: req.user?._id || req.user?.id,
      metadata: {
        orderStatus: order.orderStatus,
      },
    });
  }

  // Populate fields
  await order.populate("productId");
  await order.populate("createdBy");
  await order.populate("salesPerson", "name phoneNumber jobTitle");
  await order.populate("acceptedBy");

  const response = generateResponse(
    "Success",
    stockWasDeducted ? "Order cancelled and stock restored successfully" : "Order cancelled successfully",
    order,
    undefined
  );

  return res.status(200).json(response);
});

// ==================== GET ALL AGRI SALES ORDERS ====================

const getAllAgriSalesOrders = catchAsync(async (req, res, next) => {
  const {
    sortKey = "createdAt",
    sortOrder = "desc",
    search,
    page = 1,
    limit = 10,
    orderStatus,
    dispatchStatus, // Filter by dispatch status (DISPATCHED, IN_TRANSIT, DELIVERED, etc.)
    paymentStatus,
    productId,
    customerMobile,
    createdBy, // Filter by employee who created the order
    salesPerson, // Filter by attributed Ram Agri sales rep
    startDate,
    endDate,
    myOrders, // Boolean: if true, show only orders created by current user
    customerVillage, // Filter by village
    customerTaluka, // Filter by taluka
    customerDistrict, // Filter by district
  } = req.query;

  let query = AgriSalesOrder.find();

  // User-wise filtering: Show only orders created by current user if myOrders=true
  if (myOrders === "true" || myOrders === true) {
    const userId = req.user?._id || req.user?.id;
    if (userId) {
      query = query.where("createdBy").equals(userId);
    }
  }

  // Filter by specific createdBy (employee ID) - for admin/manager view
  if (createdBy && mongoose.isValidObjectId(createdBy)) {
    query = query.where("createdBy").equals(createdBy);
  }

  if (salesPerson && mongoose.isValidObjectId(salesPerson)) {
    query = query.where("salesPerson").equals(salesPerson);
  }

  // Search by customer name, mobile, or order number
  if (search) {
    const searchRegex = new RegExp(search, "i");
    query = query.or([
      { customerName: searchRegex },
      { customerMobile: searchRegex },
      { orderNumber: searchRegex },
      { productName: searchRegex },
    ]);
  }

  // Filter by order status
  if (orderStatus) {
    query = query.where("orderStatus").equals(orderStatus);
  }

  // Filter by dispatch status
  if (dispatchStatus) {
    query = query.where("dispatchStatus").equals(dispatchStatus);
  }

  // Filter by payment status
  if (paymentStatus) {
    query = query.where("paymentStatus").equals(paymentStatus);
  }

  // Filter by product (root or multi-line)
  if (productId && mongoose.isValidObjectId(productId)) {
    query = query.or([
      { productId },
      { "lineItems.productId": productId },
    ]);
  }

  // Filter by customer mobile
  if (customerMobile) {
    query = query.where("customerMobile").equals(customerMobile);
  }

  // Filter by location (village, taluka, district)
  if (customerVillage) {
    query = query.where("customerVillage").equals(customerVillage);
  }
  if (customerTaluka) {
    query = query.where("customerTaluka").equals(customerTaluka);
  }
  if (customerDistrict) {
    query = query.where("customerDistrict").equals(customerDistrict);
  }

  // Filter by date range
  if (startDate || endDate) {
    if (startDate && endDate) {
      const start = new Date(startDate);
      start.setHours(0, 0, 0, 0);
      const end = new Date(endDate);
      end.setHours(23, 59, 59, 999);
      query = query.where("orderDate").gte(start).lte(end);
    } else if (startDate) {
      const start = new Date(startDate);
      start.setHours(0, 0, 0, 0);
      query = query.where("orderDate").gte(start);
    } else if (endDate) {
      const end = new Date(endDate);
      end.setHours(23, 59, 59, 999);
      query = query.where("orderDate").lte(end);
    }
  }

  // Sort
  const sort = {};
  sort[sortKey] = sortOrder === "desc" ? -1 : 1;
  query = query.sort(sort);

  // Pagination
  const skip = (parseInt(page) - 1) * parseInt(limit);
  query = query.skip(skip).limit(parseInt(limit));

  // Populate references
  query = query
    .populate("productId")
    .populate("lineItems.productId")
    .populate("lineItems.ramAgriCropId")
    .populate("createdBy")
    .populate("salesPerson", "name phoneNumber jobTitle")
    .populate("acceptedBy")
    .populate("dispatchedBy")
    .populate("vehicleId")
    .populate("assignedTo", "name phoneNumber jobTitle")
    .populate("assignedBy", "name phoneNumber");

  const [ordersRaw, total] = await Promise.all([
    query.exec(),
    AgriSalesOrder.countDocuments(query.getFilter()),
  ]);
  const orders = (ordersRaw || []).map(normalizeAgriOrderSalesPerson);

  const response = generateResponse(
    "Success",
    "Agri Sales Orders fetched successfully",
    {
      data: orders,
      pagination: {
        total,
        page: parseInt(page),
        limit: parseInt(limit),
        pages: Math.ceil(total / parseInt(limit)),
      },
    },
    undefined
  );

  return res.status(200).json(response);
});

// ==================== GET OUTSTANDING ORDERS ====================

const getOutstandingAgriSalesOrders = catchAsync(async (req, res, next) => {
  const {
    sortBy = "balanceAmount",
    sortOrder = "desc",
    search,
    page = 1,
    limit = 20,
    createdBy,
  } = req.query;

  // Build aggregation pipeline to calculate balanceAmount
  const pipeline = [];

  // Match only COMPLETED orders (no date filter for outstanding)
  pipeline.push({
    $match: {
      orderStatus: "COMPLETED"
    }
  });

  // Add search filter if provided
  if (search) {
    const searchRegex = new RegExp(search, "i");
    pipeline.push({
      $match: {
        $or: [
          { customerName: searchRegex },
          { customerMobile: searchRegex },
          { orderNumber: searchRegex },
          { productName: searchRegex },
        ]
      }
    });
  }

  // Filter by createdBy if provided
  if (createdBy && mongoose.isValidObjectId(createdBy)) {
    pipeline.push({
      $match: { createdBy: new mongoose.Types.ObjectId(createdBy) }
    });
  }

  // Calculate balanceAmount = totalAmount - totalPaidAmount
  pipeline.push({
    $addFields: {
      balanceAmount: {
        $subtract: [
          { $ifNull: ["$totalAmount", 0] },
          { $ifNull: ["$totalPaidAmount", 0] }
        ]
      }
    }
  });

  // Filter orders with outstanding balance > 0 (only COMPLETED orders with balance)
  pipeline.push({
    $match: {
      balanceAmount: { $gt: 0 }
    }
  });

  // Sort by balanceAmount (most outstanding first)
  const sort = {};
  sort[sortBy] = sortOrder === "desc" ? -1 : 1;
  pipeline.push({ $sort: sort });

  // Get total count before pagination
  const countPipeline = [...pipeline, { $count: "total" }];
  const countResult = await AgriSalesOrder.aggregate(countPipeline);
  const total = countResult[0]?.total || 0;

  // Apply pagination
  const skip = (parseInt(page) - 1) * parseInt(limit);
  pipeline.push({ $skip: skip });
  pipeline.push({ $limit: parseInt(limit) });

  // Populate references
  pipeline.push({
    $lookup: {
      from: "inventoryproducts",
      localField: "productId",
      foreignField: "_id",
      as: "productId"
    }
  });
  pipeline.push({
    $lookup: {
      from: "users",
      localField: "createdBy",
      foreignField: "_id",
      as: "createdBy"
    }
  });
  pipeline.push({
    $lookup: {
      from: "users",
      localField: "assignedTo",
      foreignField: "_id",
      as: "assignedTo"
    }
  });
  pipeline.push({
    $addFields: {
      productId: { $arrayElemAt: ["$productId", 0] },
      createdBy: { $arrayElemAt: ["$createdBy", 0] },
      assignedTo: { $arrayElemAt: ["$assignedTo", 0] }
    }
  });

  const orders = await AgriSalesOrder.aggregate(pipeline);

  const response = generateResponse(
    "Success",
    "Outstanding Agri Sales Orders fetched successfully",
    {
      data: orders,
      total: total,
      pagination: {
        total,
        page: parseInt(page),
        limit: parseInt(limit),
        pages: Math.ceil(total / parseInt(limit)),
      },
    },
    undefined
  );

  return res.status(200).json(response);
});

// ==================== GET ORDER BY ID ====================

const getAgriSalesOrderById = catchAsync(async (req, res, next) => {
  const { id } = req.params;

  if (!mongoose.isValidObjectId(id)) {
    return next(new AppError("Invalid order ID format", 400));
  }

  const order = await AgriSalesOrder.findById(id)
    .populate("productId")
    .populate("createdBy")
    .populate("salesPerson", "name phoneNumber jobTitle")
    .populate("acceptedBy")
    .populate("dispatchedBy")
    .populate("vehicleId");

  if (!order) {
    return next(new AppError("Order not found", 404));
  }

  const normalizedOrder = normalizeAgriOrderSalesPerson(order);
  const response = generateResponse(
    "Success",
    "Agri Sales Order fetched successfully",
    normalizedOrder,
    undefined
  );

  return res.status(200).json(response);
});

// ==================== ADD PAYMENT TO ORDER ====================

const addPaymentToAgriSalesOrder = catchAsync(async (req, res, next) => {
  const { id } = req.params;
  const {
    paidAmount,
    paymentDate,
    modeOfPayment,
    bankName,
    transactionId,
    chequeNumber,
    receiptPhoto,
    remark,
    isWalletPayment,
    utrNumber,
    customerName,
  } = req.body;

  if (!mongoose.isValidObjectId(id)) {
    return next(new AppError("Invalid order ID format", 400));
  }

  if (!paidAmount || paidAmount <= 0) {
    return next(new AppError("Paid amount is required and must be greater than 0", 400));
  }

  if (!isWalletPayment && !modeOfPayment) {
    return next(new AppError("Payment mode is required for non-wallet payments", 400));
  }

  const order = await AgriSalesOrder.findById(id);
  if (!order) {
    return next(new AppError("Order not found", 404));
  }

  // Store previous values for activity log
  const previousTotalPaid = order.totalPaidAmount || 0;
  const previousBalance = order.balanceAmount || order.totalAmount;
  const previousPaymentStatus = order.paymentStatus;

  // Add payment
  const newPayment = {
    paidAmount,
    paymentDate: paymentDate || new Date(),
    modeOfPayment: isWalletPayment ? "Wallet" : modeOfPayment,
    bankName: bankName || "",
    transactionId: transactionId || "",
    chequeNumber: chequeNumber || "",
    utrNumber: utrNumber?.trim() || undefined,
    customerName: customerName?.trim() || order.customerName || undefined,
    receiptPhoto: receiptPhoto || [],
    remark: remark || "",
    isWalletPayment: isWalletPayment || false,
    paymentStatus: "PENDING",
  };

  if (!order.payment) order.payment = [];
  order.payment.push(newPayment);

  // Update payment totals
  order.totalPaidAmount = order.payment.reduce((sum, p) => sum + (p.paidAmount || 0), 0);
  order.balanceAmount = order.totalAmount - order.totalPaidAmount;

  // Update payment status
  if (order.balanceAmount <= 0) {
    order.paymentStatus = "COMPLETED";
  } else if (order.totalPaidAmount > 0) {
    order.paymentStatus = "PARTIAL";
  } else {
    order.paymentStatus = "PENDING";
  }

  // Add activity log
  if (!order.activityLog) order.activityLog = [];
  order.activityLog.push({
    action: "PAYMENT_ADDED",
    description: `Payment of ₹${paidAmount} added via ${isWalletPayment ? "Wallet" : modeOfPayment}`,
    performedBy: req.user?._id || req.user?.id,
    performedByName: req.user?.name || "Unknown",
    previousValue: {
      totalPaidAmount: previousTotalPaid,
      balanceAmount: previousBalance,
      paymentStatus: previousPaymentStatus,
    },
    newValue: {
      paidAmount,
      modeOfPayment: isWalletPayment ? "Wallet" : modeOfPayment,
      totalPaidAmount: order.totalPaidAmount,
      balanceAmount: order.balanceAmount,
      paymentStatus: order.paymentStatus,
    },
    metadata: {
      bankName,
      transactionId,
      remark,
      paymentIndex: order.payment.length - 1,
    },
  });

  await order.save();

  // Populate fields
  await order.populate("productId");
  await order.populate("createdBy");
  await order.populate("salesPerson", "name phoneNumber jobTitle");
  await order.populate("acceptedBy");

  const response = generateResponse(
    "Success",
    "Payment added successfully",
    order,
    undefined
  );

  return res.status(200).json(response);
});

// ==================== GENERATE PAYMENT QR (AGRI) ====================

/**
 * POST /api/v1/inventory/agri-sales-orders/:id/generate-payment-qr
 * Generate QR for agri order balance. Creates PENDING payment with 30-min expiry.
 */
const generatePaymentQRAgri = catchAsync(async (req, res, next) => {
  const { id } = req.params;
  if (!mongoose.isValidObjectId(id)) {
    return next(new AppError("Invalid order ID format", 400));
  }
  const order = await AgriSalesOrder.findById(id);
  if (!order) {
    return next(new AppError("Order not found", 404));
  }
  const totalPaid = (order.payment || []).reduce((sum, p) => (p.paymentStatus === "COLLECTED" ? sum + (p.paidAmount || 0) : sum), 0);
  const totalAmount = order.totalAmount ?? (order.quantity || 0) * (order.rate || 0);
  const outstanding = Math.round((totalAmount - totalPaid) * 100) / 100;
  if (outstanding <= 0) {
    return next(new AppError("No outstanding amount for this order", 400));
  }
  const now = new Date();
  const hasActiveQR = (order.payment || []).some(
    (p) => p.paymentStatus === "PENDING" && p.qrReferenceId && p.qrExpiresAt && new Date(p.qrExpiresAt) > now
  );
  if (hasActiveQR) {
    return next(new AppError("An active payment QR already exists for this order", 400));
  }
  const customerName = order.customerName || "Customer";
  const mobileNumber = order.customerMobile || "";
  let qrResult;
  try {
    qrResult = await generateQR({
      amount: outstanding,
      orderId: order.orderNumber,
      customerName,
      mobileNumber,
    });
  } catch (err) {
    const n = normalizeIciciError(err);
    return res.status(n.httpStatus).json({ success: false, message: n.message, code: n.code });
  }
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
  if (!order.payment) order.payment = [];
  order.payment.push(newPayment);
  await order.save();
  await saveIciciQrAuditRecord({
    orderId: order.orderNumber,
    merchantTranId: qrReferenceId,
    amount: outstanding,
    context: "AGRI_ORDER",
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
    orderId: order.orderNumber,
    customerName,
    mobileNumber,
  });
});

// ==================== UPDATE PAYMENT STATUS ====================

const updatePaymentStatus = catchAsync(async (req, res, next) => {
  const { id, paymentIndex } = req.params;
  const { paymentStatus } = req.body;

  if (!mongoose.isValidObjectId(id)) {
    return next(new AppError("Invalid order ID format", 400));
  }

  if (!["COLLECTED", "REJECTED", "PENDING", "BANK_VERIFIED"].includes(paymentStatus)) {
    return next(new AppError("Invalid payment status", 400));
  }

  const order = await AgriSalesOrder.findById(id);
  if (!order) {
    return next(new AppError("Order not found", 404));
  }

  const index = parseInt(paymentIndex);
  if (!order.payment || index < 0 || index >= order.payment.length) {
    return next(new AppError("Invalid payment index", 400));
  }

  // Store previous status for activity log
  const previousPaymentStatus = order.payment[index].paymentStatus;
  const paymentAmount = order.payment[index].paidAmount;
  const activityLogLength = order.activityLog ? order.activityLog.length : 0;

  // Update payment status
  order.payment[index].paymentStatus = paymentStatus;

  // Add activity log
  if (!order.activityLog) order.activityLog = [];
  order.activityLog.push({
    action: "PAYMENT_STATUS_CHANGED",
    description: `Payment #${index + 1} (₹${paymentAmount}) status changed from ${previousPaymentStatus} to ${paymentStatus}`,
    performedBy: req.user?._id || req.user?.id,
    performedByName: req.user?.name || "Unknown",
    previousValue: { paymentStatus: previousPaymentStatus },
    newValue: { paymentStatus },
    metadata: {
      paymentIndex: index,
      paymentAmount,
      changedAt: new Date(),
    },
  });

  await order.save();

  const shouldCreateLedgerEntry = shouldLogRamAgriLedger(order) && (
    (previousPaymentStatus !== "COLLECTED" && paymentStatus === "COLLECTED") ||
    (previousPaymentStatus === "COLLECTED" && paymentStatus !== "COLLECTED")
  );

  if (shouldCreateLedgerEntry) {
    try {
      let ledgerEntry = null;
      if (previousPaymentStatus !== "COLLECTED" && paymentStatus === "COLLECTED") {
        ledgerEntry = await createCustomerLedgerEntry({
          customerMobile: order.customerMobile,
          customerName: order.customerName,
          refType: "PAYMENT",
          refId: order.payment[index]._id,
          orderId: order._id,
          paymentId: order.payment[index]._id,
          credit: paymentAmount || 0,
          reference: order.orderNumber,
          category: "Payment",
          description: `Payment collected via ${order.payment[index].modeOfPayment || "N/A"}`,
          entryDate: new Date(),
          createdBy: req.user?._id || req.user?.id,
          metadata: {
            previousPaymentStatus,
            paymentStatus,
          },
        });
      } else if (previousPaymentStatus === "COLLECTED" && paymentStatus !== "COLLECTED") {
        ledgerEntry = await createCustomerLedgerEntry({
          customerMobile: order.customerMobile,
          customerName: order.customerName,
          refType: "REVERSAL",
          refId: order.payment[index]._id,
          orderId: order._id,
          paymentId: order.payment[index]._id,
          debit: paymentAmount || 0,
          reference: order.orderNumber,
          category: "Payment Reversal",
          description: `Payment reversed (${paymentStatus})`,
          entryDate: new Date(),
          createdBy: req.user?._id || req.user?.id,
          metadata: {
            previousPaymentStatus,
            paymentStatus,
          },
        });
      }

      if (!ledgerEntry) {
        throw new Error("Ledger entry was not created");
      }
    } catch (error) {
      order.payment[index].paymentStatus = previousPaymentStatus;
      if (order.activityLog && order.activityLog.length > activityLogLength) {
        order.activityLog.splice(activityLogLength);
      }
      await order.save();
      return next(new AppError("Ledger entry failed, payment status rolled back", 500));
    }
  }

  // Populate fields
  await order.populate("productId");
  await order.populate("createdBy");
  await order.populate("salesPerson", "name phoneNumber jobTitle");
  await order.populate("acceptedBy");

  const response = generateResponse(
    "Success",
    "Payment status updated successfully",
    order,
    undefined
  );

  return res.status(200).json(response);
});

// ==================== GET FARMER BY MOBILE (for auto-fill) ====================

const getCustomerByMobile = catchAsync(async (req, res, next) => {
  const { mobileNumber } = req.params;

  if (!mobileNumber || mobileNumber.length !== 10 || !/^\d{10}$/.test(mobileNumber)) {
    return next(new AppError("Valid 10-digit mobile number is required", 400));
  }

  // Try to find farmer first
  const farmer = await Farmer.findOne({ mobileNumber });

  if (farmer) {
    return res.status(200).json({
      status: "Success",
      message: "Customer found (Farmer)",
      data: {
        name: farmer.name,
        mobileNumber: farmer.mobileNumber,
        village: farmer.village || farmer.villageName || "",
        taluka: farmer.taluka || farmer.talukaName || "",
        district: farmer.district || farmer.districtName || "",
        state: farmer.state || farmer.stateName || "Maharashtra",
        type: "farmer",
      },
    });
  }

  // If no farmer found, return empty structure
  return res.status(404).json({
    status: "fail",
    message: "No customer found for the given mobile number",
  });
});

// ==================== UPDATE AGRI SALES ORDER ====================

const updateAgriSalesOrder = catchAsync(async (req, res, next) => {
  const { id } = req.params;
  const updateData = req.body;

  if (!mongoose.isValidObjectId(id)) {
    return next(new AppError("Invalid order ID format", 400));
  }

  const order = await AgriSalesOrder.findById(id);
  if (!order) {
    return next(new AppError("Order not found", 404));
  }

  const previousBalanceForRamAgriLimit = Math.round((Number(order.balanceAmount) || 0) * 100) / 100;

  // Don't allow updates if order is completed or cancelled (unless updating status)
  if (updateData.orderStatus) {
    // Allow status updates except to COMPLETED or CANCELLED from COMPLETED/CANCELLED
    if ((order.orderStatus === "COMPLETED" || order.orderStatus === "CANCELLED") && 
        (updateData.orderStatus === "COMPLETED" || updateData.orderStatus === "CANCELLED")) {
      return next(new AppError("Cannot change status of completed or cancelled order", 400));
    }
  } else {
    // Don't allow other field updates if order is completed or cancelled
    if (order.orderStatus === "COMPLETED" || order.orderStatus === "CANCELLED") {
      return next(new AppError("Cannot update completed or cancelled order", 400));
    }
  }

  // Fields that can be updated
  const allowedFields = [
    "customerName",
    "customerMobile",
    "customerVillage",
    "customerTaluka",
    "customerDistrict",
    "customerState",
    "productId",
    "quantity",
    "unit",
    "rate",
    "orderDate",
    "deliveryDate",
    "notes",
    "screenshots",
    "orderStatus", // Allow status updates (except COMPLETED which is blocked above)
  ];

  // Filter and validate update data
  const filteredData = {};
  Object.keys(updateData).forEach((key) => {
    if (allowedFields.includes(key)) {
      // Handle deliveryDate: allow null to clear the date
      if (key === "deliveryDate" && (updateData[key] === null || updateData[key] === undefined || updateData[key] === "")) {
        filteredData[key] = null;
      } else {
        filteredData[key] = updateData[key];
      }
    }
  });

  if (updateData.lineItems !== undefined) {
    if (!Array.isArray(updateData.lineItems) || updateData.lineItems.length === 0) {
      return next(new AppError("lineItems must be a non-empty array", 400));
    }
    try {
      filteredData.lineItems = await buildAgriLineItemsForCreate(
        updateData.lineItems,
        updateData.orderDate || order.orderDate
      );
    } catch (e) {
      return next(e instanceof AppError ? e : new AppError(e.message || "Invalid line items", 400));
    }
  }

  if (filteredData.orderStatus === "CANCELLED") {
    return next(
      new AppError(
        "Cannot set order status to CANCELLED via this endpoint. Use PATCH /inventory/agri-sales-orders/:id/cancel so ledger and stock are updated correctly.",
        400
      )
    );
  }

  // Check if there are any fields to update
  if (Object.keys(filteredData).length === 0) {
    return next(new AppError("No valid fields provided for update. Allowed fields: " + allowedFields.join(", "), 400));
  }

  // Validate mobile number if being updated
  if (filteredData.customerMobile) {
    const mobile = filteredData.customerMobile.toString();
    if (mobile.length !== 10 || !/^\d{10}$/.test(mobile)) {
      return next(new AppError("Mobile number must be exactly 10 digits", 400));
    }
    filteredData.customerMobile = mobile;
  }

  // If productId is being updated, validate it and update productName
  if (filteredData.productId) {
    if (!mongoose.isValidObjectId(filteredData.productId)) {
      return next(new AppError("Invalid product ID format", 400));
    }

    const product = await InventoryProduct.findById(filteredData.productId);
    if (!product) {
      return next(new AppError("Product not found", 404));
    }

    if (!product.isAgriSales) {
      return next(new AppError("Product is not available for Agri Sales", 400));
    }

    filteredData.productName = product.name;
    
    // If unit is not provided, use product's primary unit
    if (!filteredData.unit && product.primaryUnit) {
      filteredData.unit = product.primaryUnit.abbreviation || product.primaryUnit.name.toLowerCase();
    }
  }

  // Store previous values for activity log and edit history
  const previousValues = {};
  Object.keys(filteredData).forEach((key) => {
    previousValues[key] = order[key];
  });
  const previousTotalAmount = order.totalAmount || 0;

  // Track edit history entries (same as regular orders)
  const editHistoryEntries = [];
  
  // Track rate changes
  if (filteredData.rate !== undefined && filteredData.rate !== order.rate) {
    editHistoryEntries.push({
      field: "rate",
      previousValue: order.rate,
      newValue: filteredData.rate,
      changedBy: req.user?._id || req.user?.id,
      notes: `Rate changed from ₹${order.rate} to ₹${filteredData.rate}`,
    });
  }

  // Track quantity changes
  if (filteredData.quantity !== undefined && filteredData.quantity !== order.quantity) {
    editHistoryEntries.push({
      field: "quantity",
      previousValue: order.quantity,
      newValue: filteredData.quantity,
      changedBy: req.user?._id || req.user?.id,
      notes: `Quantity changed from ${order.quantity} to ${filteredData.quantity}`,
    });
  }

  // Track deliveryDate changes
  if (filteredData.deliveryDate !== undefined) {
    const oldDate = order.deliveryDate ? new Date(order.deliveryDate) : null;
    const newDate = filteredData.deliveryDate ? new Date(filteredData.deliveryDate) : null;
    
    // Check if date actually changed
    const oldDateStr = oldDate ? oldDate.toISOString() : null;
    const newDateStr = newDate ? newDate.toISOString() : null;
    
    if (oldDateStr !== newDateStr) {
      editHistoryEntries.push({
        field: "deliveryDate",
        previousValue: oldDate,
        newValue: newDate,
        changedBy: req.user?._id || req.user?.id,
        notes: `Delivery date changed from ${oldDate ? oldDate.toLocaleDateString('en-IN') : 'Not set'} to ${newDate ? newDate.toLocaleDateString('en-IN') : 'Not set'}`,
      });
    }
  }

  // Track customer name changes
  if (filteredData.customerName !== undefined && filteredData.customerName !== order.customerName) {
    editHistoryEntries.push({
      field: "customerName",
      previousValue: order.customerName,
      newValue: filteredData.customerName,
      changedBy: req.user?._id || req.user?.id,
      notes: `Customer name changed from "${order.customerName}" to "${filteredData.customerName}"`,
    });
  }

  // Track customer mobile changes
  if (filteredData.customerMobile !== undefined && filteredData.customerMobile !== order.customerMobile) {
    editHistoryEntries.push({
      field: "customerMobile",
      previousValue: order.customerMobile,
      newValue: filteredData.customerMobile,
      changedBy: req.user?._id || req.user?.id,
      notes: `Customer mobile changed from ${order.customerMobile} to ${filteredData.customerMobile}`,
    });
  }

  // Initialize orderEditHistory if it doesn't exist
  if (!order.orderEditHistory) {
    order.orderEditHistory = [];
  }

  // Add all edit history entries
  if (editHistoryEntries.length > 0) {
    order.orderEditHistory.push(...editHistoryEntries);
  }

  // Update order fields
  Object.keys(filteredData).forEach((key) => {
    order[key] = filteredData[key];
  });

  if (orderRequiresRamAgriOutstandingLimit(order)) {
    const salesAttribution = order.salesPerson || order.createdBy;
    if (salesAttribution) {
      const newBal = projectProvisionalBalanceAmount(order);
      await assertOutstandingAllowsOrderUpdate({
        salesPersonId: salesAttribution,
        previousBalanceAmount: previousBalanceForRamAgriLimit,
        provisionalNewBalanceAmount: newBal,
      });
    }
  }

  // Determine action type based on what was updated
  let actionType = "ORDER_UPDATED";
  let description = "Order details updated";
  
  if (filteredData.customerName || filteredData.customerMobile || filteredData.customerVillage || 
      filteredData.customerTaluka || filteredData.customerDistrict) {
    actionType = "CUSTOMER_UPDATED";
    description = "Customer details updated";
  } else if (filteredData.productId) {
    actionType = "PRODUCT_UPDATED";
    description = `Product changed to ${filteredData.productName || "new product"}`;
  } else if (filteredData.quantity !== undefined) {
    actionType = "QUANTITY_UPDATED";
    description = `Quantity changed from ${previousValues.quantity} to ${filteredData.quantity}`;
  } else if (filteredData.rate !== undefined) {
    actionType = "RATE_UPDATED";
    description = `Rate changed from ₹${previousValues.rate} to ₹${filteredData.rate}`;
  } else if (filteredData.notes !== undefined) {
    actionType = "NOTES_UPDATED";
    description = "Order notes updated";
  } else if (filteredData.deliveryDate !== undefined) {
    actionType = "DELIVERY_DATE_UPDATED";
    description = "Delivery date updated";
  }

  // Add activity log
  if (!order.activityLog) order.activityLog = [];
  order.activityLog.push({
    action: actionType,
    description,
    performedBy: req.user?._id || req.user?.id,
    performedByName: req.user?.name || "Unknown",
    previousValue: previousValues,
    newValue: filteredData,
    metadata: { fieldsUpdated: Object.keys(filteredData) },
  });

  // Save order (this will trigger pre-save hook to recalculate totalAmount and balanceAmount)
  await order.save();

  // Always update payment ledger if order is edited and has payments or amount changed
  if (shouldLogRamAgriLedger(order)) {
    const newTotalAmount = order.totalAmount || 0;
    const previousBalanceAmount = order.balanceAmount || 0;
    
    // Recalculate balance after save (in case it changed)
    const totalPaid = order.payment && order.payment.length > 0
      ? order.payment.reduce((sum, p) => {
          if (p.paymentStatus === "COLLECTED") {
            return sum + (p.paidAmount || 0);
          }
          return sum;
        }, 0)
      : 0;
    
    const newBalanceAmount = newTotalAmount - totalPaid;
    const deltaAmount = newTotalAmount - previousTotalAmount;
    const deltaBalance = newBalanceAmount - previousBalanceAmount;
    
    // Update ledger if amount changed OR if order has payments (to ensure payment ledger is always updated)
    if (deltaAmount !== 0 || (order.payment && order.payment.length > 0)) {
      try {
        // If amount changed, create adjustment entry
        if (deltaAmount !== 0) {
          await createCustomerLedgerEntry({
            customerMobile: order.customerMobile,
            customerName: order.customerName,
            refType: "ADJUSTMENT",
            refId: order._id,
            orderId: order._id,
            debit: deltaAmount > 0 ? deltaAmount : 0,
            credit: deltaAmount < 0 ? Math.abs(deltaAmount) : 0,
            reference: order.orderNumber,
            category: "Adjustment",
            description: `Order adjusted (Δ ${deltaAmount > 0 ? "+" : ""}${deltaAmount.toFixed(2)}). Outstanding: ₹${newBalanceAmount.toFixed(2)}`,
            entryDate: new Date(),
            createdBy: req.user?._id || req.user?.id,
            metadata: {
              previousTotalAmount,
              newTotalAmount,
              previousBalanceAmount,
              newBalanceAmount,
              deltaAmount,
              deltaBalance,
              totalPaid,
              fieldsUpdated: Object.keys(filteredData),
            },
          });
        }
        
        // If balance changed but amount didn't (payment-related change), create balance adjustment entry
        if (deltaAmount === 0 && deltaBalance !== 0 && (order.payment && order.payment.length > 0)) {
          await createCustomerLedgerEntry({
            customerMobile: order.customerMobile,
            customerName: order.customerName,
            refType: "BALANCE_ADJUSTMENT",
            refId: order._id,
            orderId: order._id,
            debit: deltaBalance > 0 ? deltaBalance : 0,
            credit: deltaBalance < 0 ? Math.abs(deltaBalance) : 0,
            reference: order.orderNumber,
            category: "Balance Adjustment",
            description: `Outstanding balance adjusted (Δ ${deltaBalance > 0 ? "+" : ""}${deltaBalance.toFixed(2)}). New outstanding: ₹${newBalanceAmount.toFixed(2)}`,
            entryDate: new Date(),
            createdBy: req.user?._id || req.user?.id,
            metadata: {
              previousBalanceAmount,
              newBalanceAmount,
              deltaBalance,
              totalPaid,
              fieldsUpdated: Object.keys(filteredData),
            },
          });
        }
      } catch (ledgerError) {
        console.error("Error creating ledger entry for order update:", ledgerError);
        // Don't fail the order update if ledger entry fails, but log it
      }
    }
  }

  // Populate references
  await order.populate("productId");
  await order.populate("createdBy");
  await order.populate("salesPerson", "name phoneNumber jobTitle");
  await order.populate("acceptedBy");

  const response = generateResponse(
    "Success",
    "Order updated successfully",
    order,
    undefined
  );

  return res.status(200).json(response);
});

// ==================== GET PENDING PAYMENTS FOR AGRI SALES ORDERS ====================
// Similar to sell orders pending payments - for accountant to accept/reject payments

const getPendingPayments = catchAsync(async (req, res, next) => {
  const {
    page = 1,
    limit = 1000,
    search,
    startDate,
    endDate,
    paymentStatus = "PENDING",
  } = req.query;

  const query = {};

  // Search filtering (on order fields, not payment)
  if (search) {
    query.$or = [
      { orderNumber: { $regex: search, $options: "i" } },
      { customerName: { $regex: search, $options: "i" } },
      { customerMobile: { $regex: search, $options: "i" } },
      { productName: { $regex: search, $options: "i" } },
    ];
  }

  const skip = (parseInt(page) - 1) * parseInt(limit);

  // Build date filter if dates are provided
  const dateFilter = {};
  if (startDate && startDate.trim()) {
    try {
      const [day, month, year] = startDate.split("-");
      if (day && month && year) {
        const start = new Date(`${year}-${month}-${day}T00:00:00.000Z`);
        if (!isNaN(start.getTime())) {
          dateFilter.$gte = start;
        }
      }
    } catch (error) {
      console.error("Error parsing startDate:", error);
    }
  }
  if (endDate && endDate.trim()) {
    try {
      const [day, month, year] = endDate.split("-");
      if (day && month && year) {
        const end = new Date(`${year}-${month}-${day}T23:59:59.999Z`);
        if (!isNaN(end.getTime())) {
          dateFilter.$lte = end;
        }
      }
    } catch (error) {
      console.error("Error parsing endDate:", error);
    }
  }

  // Use aggregation to unwind payments and filter
  const pipeline = [
    { $match: query },
    { $unwind: { path: "$payment", includeArrayIndex: "paymentIndex", preserveNullAndEmptyArrays: false } },
    {
      $match: {
        ...(paymentStatus ? { "payment.paymentStatus": paymentStatus } : {}),
        ...(Object.keys(dateFilter).length > 0 ? { "payment.paymentDate": dateFilter } : {}),
      },
    },
    {
      $lookup: {
        from: "users",
        localField: "createdBy",
        foreignField: "_id",
        as: "createdByData",
      },
    },
    {
      $lookup: {
        from: "inventoryproducts",
        localField: "productId",
        foreignField: "_id",
        as: "productData",
      },
    },
    {
      $project: {
        _id: 1,
        orderNumber: 1,
        customerName: 1,
        customerMobile: 1,
        customerVillage: 1,
        customerTaluka: 1,
        customerDistrict: 1,
        customerState: 1,
        productId: { $arrayElemAt: ["$productData", 0] },
        productName: 1,
        quantity: 1,
        unit: 1,
        rate: 1,
        totalAmount: 1,
        orderStatus: 1,
        paymentStatus: 1,
        totalPaidAmount: 1,
        balanceAmount: 1,
        orderDate: 1,
        deliveryDate: 1,
        payment: 1,
        paymentIndex: 1, // Include payment index for status updates
        screenshots: 1, // Include screenshots for image viewing
        createdBy: { $arrayElemAt: ["$createdByData", 0] },
        acceptedBy: 1,
        createdAt: 1,
      },
    },
    { $sort: { "createdAt": -1 } },
    { $skip: skip },
    { $limit: parseInt(limit) },
  ];

  const [payments, totalCountResult] = await Promise.all([
    AgriSalesOrder.aggregate(pipeline),
    AgriSalesOrder.aggregate([
      { $match: query },
      { $unwind: "$payment" },
      {
        $match: paymentStatus ? { "payment.paymentStatus": paymentStatus } : {},
      },
      { $count: "total" },
    ]),
  ]);

  const total = totalCountResult[0]?.total || 0;

  const response = generateResponse(
    "Success",
    "Pending payments fetched successfully",
    {
      data: payments,
      pagination: {
        total,
        page: parseInt(page),
        limit: parseInt(limit),
        pages: Math.ceil(total / parseInt(limit)),
      },
    },
    undefined
  );

  return res.status(200).json(response);
});

// ==================== GET PENDING PAYMENTS COUNT ====================
// Get count of pending payments for Ram Agri Sales orders

const getPendingPaymentsCount = catchAsync(async (req, res, next) => {
  try {
    const count = await AgriSalesOrder.aggregate([
      { $unwind: { path: "$payment", preserveNullAndEmptyArrays: false } },
      { $match: { "payment.paymentStatus": "PENDING" } },
      { $count: "total" },
    ]);

    const totalCount = count[0]?.total || 0;

    const response = generateResponse(
      "Success",
      "Pending payments count fetched successfully",
      { count: totalCount },
      undefined
    );

    return res.status(200).json(response);
  } catch (error) {
    return next(new AppError(`Failed to fetch pending payments count: ${error.message}`, 500));
  }
});

// ==================== GET OUTSTANDING ANALYSIS ====================
// Get outstanding amounts grouped by salesmen, district, taluka, villages

const getOutstandingAnalysis = catchAsync(async (req, res, next) => {
  const { startDate, endDate, createdBy } = req.query;

  try {
    // Build match query
    const matchQuery = {
      balanceAmount: { $gt: 0 }, // Only orders with outstanding balance
    };

    // If logged-in user has jobTitle RAM_AGRI_SALES, filter by their user ID
    // RAM_AGRI_SALES_MANAGER can see all orders (no filter)
    // Otherwise, use the createdBy query parameter if provided
    if (req.user && req.user.jobTitle === "RAM_AGRI_SALES") {
      matchQuery.createdBy = req.user._id;
    } else if (req.user && isRamAgriSalesProgramLead(req.user)) {
      // Manager / Ram Agri office manager: all orders; optional createdBy filter
      if (createdBy && mongoose.isValidObjectId(createdBy)) {
        matchQuery.createdBy = new mongoose.Types.ObjectId(createdBy);
      }
    } else if (createdBy && mongoose.isValidObjectId(createdBy)) {
      matchQuery.createdBy = new mongoose.Types.ObjectId(createdBy);
    }

    if (startDate || endDate) {
      matchQuery.orderDate = {};
      if (startDate) {
        const start = new Date(startDate);
        start.setHours(0, 0, 0, 0);
        matchQuery.orderDate.$gte = start;
      }
      if (endDate) {
        const end = new Date(endDate);
        end.setHours(23, 59, 59, 999);
        matchQuery.orderDate.$lte = end;
      }
    }

    // Total outstanding
    const totalOutstanding = await AgriSalesOrder.aggregate([
      { $match: matchQuery },
      {
        $group: {
          _id: null,
          totalOutstanding: { $sum: "$balanceAmount" },
          totalOrders: { $sum: 1 },
        },
      },
    ]);

    // By Salesmen (createdBy)
    const bySalesmen = await AgriSalesOrder.aggregate([
      { $match: matchQuery },
      {
        $lookup: {
          from: "users",
          localField: "createdBy",
          foreignField: "_id",
          as: "salesmanData",
        },
      },
      { $unwind: { path: "$salesmanData", preserveNullAndEmptyArrays: true } },
      {
        $group: {
          _id: "$createdBy",
          salesmanName: { $first: "$salesmanData.name" },
          salesmanPhone: { $first: "$salesmanData.phoneNumber" },
          totalOutstanding: { $sum: "$balanceAmount" },
          totalOrders: { $sum: 1 },
        },
      },
      { $sort: { totalOutstanding: -1 } },
    ]);

    // By District
    const byDistrict = await AgriSalesOrder.aggregate([
      { $match: matchQuery },
      {
        $group: {
          _id: "$customerDistrict",
          totalOutstanding: { $sum: "$balanceAmount" },
          totalOrders: { $sum: 1 },
        },
      },
      { $sort: { totalOutstanding: -1 } },
    ]);

    // By Taluka
    const byTaluka = await AgriSalesOrder.aggregate([
      { $match: matchQuery },
      {
        $group: {
          _id: {
            district: "$customerDistrict",
            taluka: "$customerTaluka",
          },
          totalOutstanding: { $sum: "$balanceAmount" },
          totalOrders: { $sum: 1 },
        },
      },
      { $sort: { totalOutstanding: -1 } },
    ]);

    // By Village
    const byVillage = await AgriSalesOrder.aggregate([
      { $match: matchQuery },
      {
        $group: {
          _id: {
            district: "$customerDistrict",
            taluka: "$customerTaluka",
            village: "$customerVillage",
          },
          totalOutstanding: { $sum: "$balanceAmount" },
          totalOrders: { $sum: 1 },
        },
      },
      { $sort: { totalOutstanding: -1 } },
    ]);

    const response = generateResponse(
      "Success",
      "Outstanding analysis fetched successfully",
      {
        total: totalOutstanding[0] || { totalOutstanding: 0, totalOrders: 0 },
        bySalesmen,
        byDistrict,
        byTaluka,
        byVillage,
      },
      undefined
    );

    return res.status(200).json(response);
  } catch (error) {
    return next(new AppError(`Failed to fetch outstanding analysis: ${error.message}`, 500));
  }
});

// ==================== GET SALES ANALYSIS ====================
// Get sales analysis grouped by salesmen, district, taluka, village

const getSalesAnalysis = catchAsync(async (req, res, next) => {
  const { startDate, endDate, createdBy } = req.query;

  try {
    // Build match query (all orders, not just outstanding)
    const matchQuery = {};

    if (createdBy && mongoose.isValidObjectId(createdBy)) {
      matchQuery.createdBy = new mongoose.Types.ObjectId(createdBy);
    }

    if (startDate || endDate) {
      matchQuery.orderDate = {};
      if (startDate) {
        const start = new Date(startDate);
        start.setHours(0, 0, 0, 0);
        matchQuery.orderDate.$gte = start;
      }
      if (endDate) {
        const end = new Date(endDate);
        end.setHours(23, 59, 59, 999);
        matchQuery.orderDate.$lte = end;
      }
    }

    // Total sales
    const totalSales = await AgriSalesOrder.aggregate([
      { $match: matchQuery },
      {
        $group: {
          _id: null,
          totalAmount: { $sum: "$totalAmount" },
          totalOrders: { $sum: 1 },
        },
      },
    ]);

    // By Salesmen (createdBy)
    const bySalesmen = await AgriSalesOrder.aggregate([
      { $match: matchQuery },
      {
        $lookup: {
          from: "users",
          localField: "createdBy",
          foreignField: "_id",
          as: "salesmanData",
        },
      },
      { $unwind: { path: "$salesmanData", preserveNullAndEmptyArrays: true } },
      {
        $group: {
          _id: "$createdBy",
          salesmanName: { $first: "$salesmanData.name" },
          salesmanPhone: { $first: "$salesmanData.phoneNumber" },
          totalAmount: { $sum: "$totalAmount" },
          totalOrders: { $sum: 1 },
        },
      },
      { $sort: { totalAmount: -1 } },
    ]);

    // By District (for each salesman)
    const byDistrict = await AgriSalesOrder.aggregate([
      { $match: matchQuery },
      {
        $group: {
          _id: {
            createdBy: "$createdBy",
            district: "$customerDistrict",
          },
          totalAmount: { $sum: "$totalAmount" },
          totalOrders: { $sum: 1 },
        },
      },
      { $sort: { totalAmount: -1 } },
    ]);

    // By Taluka
    const byTaluka = await AgriSalesOrder.aggregate([
      { $match: matchQuery },
      {
        $group: {
          _id: {
            createdBy: "$createdBy",
            district: "$customerDistrict",
            taluka: "$customerTaluka",
          },
          totalAmount: { $sum: "$totalAmount" },
          totalOrders: { $sum: 1 },
        },
      },
      { $sort: { totalAmount: -1 } },
    ]);

    // By Village
    const byVillage = await AgriSalesOrder.aggregate([
      { $match: matchQuery },
      {
        $group: {
          _id: {
            createdBy: "$createdBy",
            district: "$customerDistrict",
            taluka: "$customerTaluka",
            village: "$customerVillage",
          },
          totalAmount: { $sum: "$totalAmount" },
          totalOrders: { $sum: 1 },
        },
      },
      { $sort: { totalAmount: -1 } },
    ]);

    const response = generateResponse(
      "Success",
      "Sales analysis fetched successfully",
      {
        total: totalSales[0] || { totalAmount: 0, totalOrders: 0 },
        bySalesmen,
        byDistrict,
        byTaluka,
        byVillage,
      },
      undefined
    );

    return res.status(200).json(response);
  } catch (error) {
    return next(new AppError(`Failed to fetch sales analysis: ${error.message}`, 500));
  }
});

// ==================== GET CUSTOMER OUTSTANDING ====================
// Get outstanding amounts grouped by customer (farmer)

const getCustomerOutstanding = catchAsync(async (req, res, next) => {
  const { startDate, endDate } = req.query;

  try {
    const matchQuery = {
      balanceAmount: { $gt: 0 },
    };

    if (startDate || endDate) {
      matchQuery.orderDate = {};
      if (startDate) {
        const start = new Date(startDate);
        start.setHours(0, 0, 0, 0);
        matchQuery.orderDate.$gte = start;
      }
      if (endDate) {
        const end = new Date(endDate);
        end.setHours(23, 59, 59, 999);
        matchQuery.orderDate.$lte = end;
      }
    }

    const customerOutstanding = await AgriSalesOrder.aggregate([
      { $match: matchQuery },
      {
        $group: {
          _id: {
            customerMobile: "$customerMobile",
            customerName: "$customerName",
          },
          customerVillage: { $first: "$customerVillage" },
          customerTaluka: { $first: "$customerTaluka" },
          customerDistrict: { $first: "$customerDistrict" },
          totalOutstanding: { $sum: "$balanceAmount" },
          totalOrders: { $sum: 1 },
          orders: {
            $push: {
              orderNumber: "$orderNumber",
              orderDate: "$orderDate",
              totalAmount: "$totalAmount",
              totalPaidAmount: "$totalPaidAmount",
              balanceAmount: "$balanceAmount",
              orderStatus: "$orderStatus",
            },
          },
        },
      },
      { $sort: { totalOutstanding: -1 } },
    ]);

    const response = generateResponse(
      "Success",
      "Customer outstanding fetched successfully",
      { data: customerOutstanding },
      undefined
    );

    return res.status(200).json(response);
  } catch (error) {
    return next(new AppError(`Failed to fetch customer outstanding: ${error.message}`, 500));
  }
});

// ==================== ASSIGN ORDERS TO SALES PERSON ====================
// Admin assigns orders to a sales person for dispatch (no stock deduction)

const assignOrdersToSalesPerson = catchAsync(async (req, res, next) => {
  const {
    orderIds, // Array of order IDs to assign
    assignToUserId, // User ID of the sales person
    assignmentNotes, // Optional notes
  } = req.body;

  // Validate required fields
  if (!orderIds || !Array.isArray(orderIds) || orderIds.length === 0) {
    return next(new AppError("At least one order ID is required", 400));
  }

  if (!assignToUserId) {
    return next(new AppError("Sales person ID is required", 400));
  }

  if (!mongoose.isValidObjectId(assignToUserId)) {
    return next(new AppError("Invalid sales person ID format", 400));
  }

  // Validate all order IDs
  for (const orderId of orderIds) {
    if (!mongoose.isValidObjectId(orderId)) {
      return next(new AppError(`Invalid order ID format: ${orderId}`, 400));
    }
  }

  // Verify the sales person exists and is a RAM_AGRI_SALES user
  const salesPerson = await User.findById(assignToUserId);
  if (!salesPerson) {
    return next(new AppError("Sales person not found", 404));
  }

  // Get user info for activity log
  const adminUserId = req.user?._id || req.user?.id;
  const adminUserName = req.user?.name || "Unknown";

  // Find orders that can be assigned (PENDING or ACCEPTED, not yet dispatched)
  const orders = await AgriSalesOrder.find({
    _id: { $in: orderIds },
    orderStatus: { $in: ["PENDING", "ACCEPTED"] },
    dispatchStatus: "NOT_DISPATCHED",
  });

  if (orders.length === 0) {
    return next(new AppError("No valid orders found for assignment. Orders must be PENDING or ACCEPTED and not yet dispatched.", 404));
  }

  const assignedAt = new Date();
  const updatedOrders = [];

  for (const order of orders) {
    const previousAssignedTo = order.assignedTo;

    const previousOrderStatus = order.orderStatus;
    
    // Update assignment fields
    order.assignedTo = assignToUserId;
    order.assignedAt = assignedAt;
    order.assignedBy = adminUserId;
    order.assignmentNotes = assignmentNotes || "";

    // Set order status to ASSIGNED
    order.orderStatus = "ASSIGNED";
    
    // If order was PENDING, also set accepted info
    if (previousOrderStatus === "PENDING") {
      order.acceptedBy = adminUserId;
      order.acceptedAt = assignedAt;
    }

    // Add activity log
    if (!order.activityLog) order.activityLog = [];
    order.activityLog.push({
      action: "ORDER_ASSIGNED",
      description: `Order assigned to ${salesPerson.name} (${salesPerson.phoneNumber}) for dispatch. Status: ${previousOrderStatus} → ASSIGNED`,
      performedBy: adminUserId,
      performedByName: adminUserName,
      previousValue: { 
        assignedTo: previousAssignedTo,
        orderStatus: previousOrderStatus,
      },
      newValue: { 
        assignedTo: assignToUserId,
        assignedToName: salesPerson.name,
        orderStatus: "ASSIGNED",
      },
      metadata: {
        assignmentNotes,
        assignedAt,
        salesPersonName: salesPerson.name,
        salesPersonPhone: salesPerson.phoneNumber,
      },
    });

    await order.save();
    updatedOrders.push(order);
  }

  // Populate fields for response
  await AgriSalesOrder.populate(updatedOrders, [
    { path: "productId" },
    { path: "createdBy" },
    { path: "salesPerson", select: "name phoneNumber jobTitle" },
    { path: "assignedTo", select: "name phoneNumber jobTitle" },
    { path: "assignedBy", select: "name phoneNumber" },
  ]);

  const response = generateResponse(
    "Success",
    `${updatedOrders.length} order(s) assigned to ${salesPerson.name} successfully`,
    {
      orders: updatedOrders,
      assignedTo: {
        _id: salesPerson._id,
        name: salesPerson.name,
        phoneNumber: salesPerson.phoneNumber,
      },
      totalAssigned: updatedOrders.length,
    },
    undefined
  );

  return res.status(200).json(response);
});

// ==================== GET ASSIGNED ORDERS FOR SALES PERSON ====================
// Get orders assigned to a specific sales person (for their dispatch view)

const getAssignedOrders = catchAsync(async (req, res, next) => {
  const {
    page = 1,
    limit = 100,
    search,
    assignedTo, // Optional: filter by specific user (admin view)
  } = req.query;

  const userId = req.user?._id || req.user?.id;
  const userRole = req.user?.role;
  const userJobTitle = req.user?.jobTitle;

  // Build query
  let query = {
    orderStatus: "ASSIGNED", // Only show orders with ASSIGNED status
    dispatchStatus: "NOT_DISPATCHED", // Only show orders not yet dispatched
    assignedTo: { $exists: true, $ne: null }, // Must be assigned
  };

  // If user is a sales person, only show their assigned orders
  // RAM_AGRI_SALES_MANAGER can see all orders (no filter)
  // If admin, can view all or filter by assignedTo
  if (userJobTitle === "RAM_AGRI_SALES" && userRole !== "SUPER_ADMIN") {
    query.assignedTo = userId;
  } else if (isRamAgriSalesProgramLead({ jobTitle: userJobTitle, role: userRole }) && userRole !== "SUPER_ADMIN") {
    // Program lead / Ram Agri office manager: all assigned orders; optional assignedTo filter
    if (assignedTo && mongoose.isValidObjectId(assignedTo)) {
      query.assignedTo = assignedTo;
    }
  } else if (assignedTo && mongoose.isValidObjectId(assignedTo)) {
    query.assignedTo = assignedTo;
  }

  // Search filter
  if (search) {
    const searchRegex = new RegExp(search, "i");
    query.$or = [
      { customerName: searchRegex },
      { customerMobile: searchRegex },
      { orderNumber: searchRegex },
      { customerVillage: searchRegex },
    ];
  }

  // Execute query with pagination
  const skip = (parseInt(page) - 1) * parseInt(limit);
  
  const [orders, total] = await Promise.all([
    AgriSalesOrder.find(query)
      .populate("productId")
      .populate("createdBy", "name phoneNumber")
      .populate("salesPerson", "name phoneNumber jobTitle")
      .populate("assignedTo", "name phoneNumber jobTitle")
      .populate("assignedBy", "name phoneNumber")
      .populate("ramAgriCropId")
      .populate("primaryUnit")
      .populate("secondaryUnit")
      .sort({ assignedAt: -1 })
      .skip(skip)
      .limit(parseInt(limit))
      .lean(),
    AgriSalesOrder.countDocuments(query),
  ]);

  // Calculate payment summary for each order
  const ordersWithSummary = orders.map((order) => {
    const paymentSummary = {
      totalPaid: 0,
      totalPending: 0,
      totalRejected: 0,
      count: order.payment?.length || 0,
    };

    if (order.payment && Array.isArray(order.payment)) {
      order.payment.forEach((p) => {
        if (p.paymentStatus === "COLLECTED") {
          paymentSummary.totalPaid += p.paidAmount || 0;
        } else if (p.paymentStatus === "PENDING") {
          paymentSummary.totalPending += p.paidAmount || 0;
        } else if (p.paymentStatus === "REJECTED") {
          paymentSummary.totalRejected += p.paidAmount || 0;
        }
      });
    }

    return {
      ...order,
      paymentSummary,
    };
  });

  const response = generateResponse(
    "Success",
    "Assigned orders fetched successfully",
    {
      data: ordersWithSummary,
      pagination: {
        total,
        page: parseInt(page),
        limit: parseInt(limit),
        pages: Math.ceil(total / parseInt(limit)),
      },
    },
    undefined
  );

  return res.status(200).json(response);
});

// ==================== CANCEL ASSIGNMENT ====================
// Admin or sales person can cancel assignment (return to unassigned state)

const cancelAssignment = catchAsync(async (req, res, next) => {
  const { id } = req.params;
  const { reason } = req.body;

  if (!mongoose.isValidObjectId(id)) {
    return next(new AppError("Invalid order ID format", 400));
  }

  const order = await AgriSalesOrder.findById(id);
  if (!order) {
    return next(new AppError("Order not found", 404));
  }

  if (!order.assignedTo) {
    return next(new AppError("Order is not assigned to anyone", 400));
  }

  // Get previous assignment info for activity log
  const previousAssignedTo = order.assignedTo;
  const previousAssignedToUser = await User.findById(previousAssignedTo);
  const previousOrderStatus = order.orderStatus;

  // Get user info for activity log
  const userId = req.user?._id || req.user?.id;
  const userName = req.user?.name || "Unknown";

  // Clear assignment and revert order status to ACCEPTED
  order.assignedTo = null;
  order.assignedAt = null;
  order.assignedBy = null;
  order.assignmentNotes = null;
  order.orderStatus = "ACCEPTED"; // Revert to ACCEPTED status

  // Add activity log
  if (!order.activityLog) order.activityLog = [];
  order.activityLog.push({
    action: "ASSIGNMENT_CANCELLED",
    description: `Assignment cancelled${previousAssignedToUser ? ` (was assigned to ${previousAssignedToUser.name})` : ""}${reason ? `: ${reason}` : ""}. Status: ${previousOrderStatus} → ACCEPTED`,
    performedBy: userId,
    performedByName: userName,
    previousValue: { 
      assignedTo: previousAssignedTo,
      assignedToName: previousAssignedToUser?.name,
      orderStatus: previousOrderStatus,
    },
    newValue: { 
      assignedTo: null,
      orderStatus: "ACCEPTED",
    },
    metadata: { reason },
  });

  await order.save();

  // Populate fields
  await order.populate("productId");
  await order.populate("createdBy");
  await order.populate("salesPerson", "name phoneNumber jobTitle");

  const response = generateResponse(
    "Success",
    "Assignment cancelled successfully",
    order,
    undefined
  );

  return res.status(200).json(response);
});

// ==================== DISPATCH ORDERS ====================
// Dispatch single or multiple orders with vehicle/driver or courier details

const dispatchOrders = catchAsync(async (req, res, next) => {
  const {
    orderIds, // Array of order IDs to dispatch
    dispatchMode = "VEHICLE", // VEHICLE or COURIER or WITH_ORDER
    // Vehicle mode fields
    vehicleId,
    vehicleNumber,
    driverName,
    driverMobile,
    // Courier mode fields
    courierName,
    courierTrackingId,
    courierContact,
    // Common fields
    dispatchNotes,
  } = req.body;

  // Validate required fields
  if (!orderIds || !Array.isArray(orderIds) || orderIds.length === 0) {
    return next(new AppError("At least one order ID is required", 400));
  }

  // Validate dispatch mode (vehicle fields are validated after linked-order prefill resolution).
  if (!["VEHICLE", "COURIER", "WITH_ORDER", "OFFICE"].includes(dispatchMode)) {
    return next(
      new AppError("Invalid dispatch mode. Must be VEHICLE, COURIER, WITH_ORDER, or OFFICE", 400)
    );
  }
  if (dispatchMode === "COURIER" && !courierName) {
    return next(new AppError("Courier service name is required for courier dispatch", 400));
  }
  if (dispatchMode === "OFFICE" && (!dispatchNotes || !String(dispatchNotes).trim())) {
    return next(
      new AppError("Dispatch remark/notes are required when dispatching from office (OFFICE mode)", 400)
    );
  }

  // Validate all order IDs
  for (const orderId of orderIds) {
    if (!mongoose.isValidObjectId(orderId)) {
      return next(new AppError(`Invalid order ID format: ${orderId}`, 400));
    }
  }

  // Initialize dispatch details
  let finalVehicleNumber = vehicleNumber || "";
  let finalDriverName = driverName || "";
  let finalDriverMobile = driverMobile || "";
  let finalCourierName = courierName || "";
  let finalCourierTrackingId = courierTrackingId || "";
  let finalCourierContact = courierContact || "";

  // Get vehicle details if vehicleId is provided (for direct VEHICLE mode)
  if (dispatchMode === "VEHICLE" && vehicleId && mongoose.isValidObjectId(vehicleId)) {
    const vehicleDetails = await Vehicle.findById(vehicleId);
    if (vehicleDetails) {
      finalVehicleNumber = vehicleDetails.number || vehicleNumber;
      // Use vehicle's driver if not provided in request
      if (!driverName && vehicleDetails.driverName) {
        finalDriverName = vehicleDetails.driverName;
      }
      if (!driverMobile && vehicleDetails.driverMobile) {
        finalDriverMobile = vehicleDetails.driverMobile;
      }
    }
  }

  // Get user info for activity log
  const userId = req.user?._id || req.user?.id;
  const userName = req.user?.name || "Unknown";
  const userRole = req.user?.role;
  const userJobTitle = req.user?.jobTitle;

  // Determine if user is admin (can dispatch directly with stock deduction)
  // or sales person (dispatching their assigned orders - stock should be deducted)
  // Prioritize jobTitle over role
  const effectiveRole = userJobTitle || userRole;
  const isAdmin =
    effectiveRole === "SUPER_ADMIN" ||
    effectiveRole === "ADMIN" ||
    effectiveRole === "OFFICE_ADMIN" ||
    effectiveRole === RAM_AGRI_SALES_OFFICE_MANAGER;

  // Find and update all orders - ACCEPTED or ASSIGNED orders can be dispatched
  const orders = await AgriSalesOrder.find({
    _id: { $in: orderIds },
    orderStatus: { $in: ["ACCEPTED", "ASSIGNED"] }, // ACCEPTED or ASSIGNED orders can be dispatched
  });

  if (orders.length === 0) {
    return next(new AppError("No valid orders found for dispatch. Orders must be in ACCEPTED or ASSIGNED status.", 404));
  }

  const linkedDispatchTrailByAgriOrderId = new Map();
  // Resolve linked nursery dispatch trail when needed (vehicle prefill / WITH_ORDER mode).
  if (
    dispatchMode === "WITH_ORDER" ||
    (dispatchMode === "VEHICLE" && (!finalVehicleNumber || !finalDriverName || !finalDriverMobile))
  ) {
    const linkedOrderIdByAgriOrderId = new Map();
    const linkedNurseryOrderIds = [];
    for (const agriOrder of orders) {
      const linkedId = agriOrder?.linkedNurseryOrderId;
      if (!linkedId || !mongoose.isValidObjectId(String(linkedId))) continue;
      const linkedOrderId = String(linkedId);
      linkedOrderIdByAgriOrderId.set(String(agriOrder._id), linkedOrderId);
      linkedNurseryOrderIds.push(linkedOrderId);
    }
    const uniqLinkedNurseryOrderIds = Array.from(new Set(linkedNurseryOrderIds));
    if (dispatchMode === "WITH_ORDER" && !uniqLinkedNurseryOrderIds.length) {
      return next(
        new AppError(
          "WITH_ORDER dispatch requires linked regular nursery orders with dispatch history.",
          400
        )
      );
    }
    if (uniqLinkedNurseryOrderIds.length > 0) {
      const linkedOrders = await Order.find({ _id: { $in: uniqLinkedNurseryOrderIds } })
        .populate({
          path: "dispatchHistory.dispatchId",
          select: "transportId driverName driverMobile vehicleName vehicleNumber createdAt updatedAt",
        })
        .select("dispatchHistory")
        .lean();
      const latestByLinkedOrderId = new Map();
      const candidates = [];
      for (const linkedOrder of linkedOrders) {
        const linkedOrderId = String(linkedOrder?._id || "");
        const hist = Array.isArray(linkedOrder?.dispatchHistory) ? linkedOrder.dispatchHistory : [];
        if (!hist.length) continue;
        const latest = hist[hist.length - 1];
        const dispatchDoc = latest?.dispatchId || null;
        const vehicle =
          dispatchDoc?.vehicleNumber ||
          dispatchDoc?.vehicleName ||
          latest?.vehicleName ||
          "";
        const driver =
          dispatchDoc?.driverName ||
          latest?.driverName ||
          "";
        const mobile = dispatchDoc?.driverMobile || "";
        const sortDate = new Date(
          latest?.date || dispatchDoc?.updatedAt || dispatchDoc?.createdAt || Date.now()
        ).getTime();
        const trail = {
          linkedNurseryDispatchId: dispatchDoc?._id || null,
          linkedNurseryTransportId: dispatchDoc?.transportId
            ? String(dispatchDoc.transportId)
            : "",
          linkedNurseryDispatchDate: latest?.date || dispatchDoc?.createdAt || null,
          vehicle,
          driver,
          mobile,
          sortDate,
        };
        latestByLinkedOrderId.set(linkedOrderId, trail);
        candidates.push(trail);
      }
      for (const agriOrder of orders) {
        const linkedOrderId = linkedOrderIdByAgriOrderId.get(String(agriOrder._id));
        if (!linkedOrderId) continue;
        const linkedTrail = latestByLinkedOrderId.get(linkedOrderId);
        if (linkedTrail) {
          linkedDispatchTrailByAgriOrderId.set(String(agriOrder._id), linkedTrail);
        }
      }
      if (candidates.length > 0) {
        candidates.sort((a, b) => b.sortDate - a.sortDate);
        const best = candidates[0];
        if (!finalVehicleNumber && best.vehicle) finalVehicleNumber = best.vehicle;
        if (!finalDriverName && best.driver) finalDriverName = best.driver;
        if (!finalDriverMobile && best.mobile) finalDriverMobile = best.mobile;
      }
      if (dispatchMode === "WITH_ORDER") {
        const missingTrailOrders = orders
          .filter((agriOrder) => !linkedDispatchTrailByAgriOrderId.has(String(agriOrder._id)))
          .map((agriOrder) => agriOrder.orderNumber);
        if (missingTrailOrders.length > 0) {
          return next(
            new AppError(
              `Linked regular dispatch not found for Agri order(s): ${missingTrailOrders.join(", ")}`,
              400
            )
          );
        }
      }
    }
  }

  if (dispatchMode === "VEHICLE" || dispatchMode === "WITH_ORDER") {
    if (!finalVehicleNumber) {
      return next(
        new AppError(
          "Vehicle number is required for vehicle dispatch (or must be available from linked regular dispatch)",
          400
        )
      );
    }
    if (!finalDriverName) {
      return next(
        new AppError(
          "Driver name is required for vehicle dispatch (or must be available from linked regular dispatch)",
          400
        )
      );
    }
    if (!finalDriverMobile) {
      return next(
        new AppError(
          "Driver mobile is required for vehicle dispatch (or must be available from linked regular dispatch)",
          400
        )
      );
    }
  }

  // For sales person (not manager), verify they are dispatching their own assigned orders
  // RAM_AGRI_SALES_MANAGER can dispatch any order (same as admin for dispatch purposes)
  const isSalesPersonDispatchingAssigned = !isAdmin && userJobTitle === "RAM_AGRI_SALES";
  
  if (isSalesPersonDispatchingAssigned) {
    const unassignedOrders = orders.filter(
      (o) => !o.assignedTo || o.assignedTo.toString() !== userId.toString()
    );
    if (unassignedOrders.length > 0) {
      return next(new AppError("You can only dispatch orders assigned to you", 403));
    }
  }

  // Update each order and deduct stock (only if admin dispatches directly)
  const updatedOrders = [];
  const dispatchedAt = new Date();
  const stockDeductionResults = [];

  for (const order of orders) {
    const previousDispatchStatus = order.dispatchStatus;
    const previousOrderStatus = order.orderStatus;
    let stockBefore = 0;
    let stockAfter = 0;
    let stockDeductionSuccess = false;

    // Determine if this order was assigned to a sales person
    const isAssignedOrder = order.assignedTo != null;

    // DEDUCT STOCK ON DISPATCH - ONLY if admin dispatches directly (not assigned orders)
    // When sales person dispatches their assigned orders, stock is NOT deducted
    // Sales person orders don't impact warehouse stock - they manage their own inventory
    const shouldDeductStock = isAdmin && !isAssignedOrder;
    
    if (shouldDeductStock && !order.stockDeducted) {
      try {
        const ded = await deductStockForAgriOrderLines(order, order.orderNumber, userId);
        if (!ded.ok) {
          return next(ded.error);
        }
        stockDeductionSuccess = true;
      } catch (stockError) {
        console.error(`Error deducting stock for order ${order.orderNumber}:`, stockError);
        return next(new AppError(`Failed to deduct stock for order ${order.orderNumber}: ${stockError.message}`, 500));
      }

      if (stockDeductionSuccess) {
        order.stockDeducted = true;
        order.stockDeductedAt = new Date();
      }
    } else if (isAssignedOrder) {
      // Assigned order - no stock deduction, just mark as success for logging
      stockDeductionSuccess = false; // No stock was deducted
    } else {
      // Stock was already deducted (shouldn't happen in new flow, but handle gracefully)
      stockDeductionSuccess = true;
    }

    stockDeductionResults.push({
      orderId: order._id,
      orderNumber: order.orderNumber,
      stockDeducted: stockDeductionSuccess,
      stockBefore,
      stockAfter,
      quantityDeducted: shouldDeductStock ? order.quantity : 0,
      wasAssignedOrder: isAssignedOrder,
    });

    // Update common dispatch fields
    order.dispatchStatus = "DISPATCHED";
    order.orderStatus = "DISPATCHED"; // Update order status as well
    order.dispatchMode = dispatchMode;
    order.dispatchedAt = dispatchedAt;
    order.dispatchedBy = userId;
    order.dispatchNotes = dispatchNotes || "";

    // Update mode-specific fields
    if (dispatchMode === "VEHICLE" || dispatchMode === "WITH_ORDER") {
      const linkedTrail = linkedDispatchTrailByAgriOrderId.get(String(order._id));
      order.vehicleId = vehicleId || null;
      order.vehicleNumber = finalVehicleNumber || linkedTrail?.vehicle || "";
      order.driverName = finalDriverName || linkedTrail?.driver || "";
      order.driverMobile = finalDriverMobile || linkedTrail?.mobile || "";
      order.linkedNurseryDispatchId = linkedTrail?.linkedNurseryDispatchId || null;
      order.linkedNurseryTransportId = linkedTrail?.linkedNurseryTransportId || "";
      order.linkedNurseryDispatchDate = linkedTrail?.linkedNurseryDispatchDate || null;
      // Clear courier fields
      order.courierName = "";
      order.courierTrackingId = "";
      order.courierContact = "";
    } else if (dispatchMode === "COURIER") {
      order.courierName = finalCourierName;
      order.courierTrackingId = finalCourierTrackingId;
      order.courierContact = finalCourierContact;
      // Clear vehicle fields
      order.vehicleId = null;
      order.vehicleNumber = "";
      order.driverName = "";
      order.driverMobile = "";
      order.linkedNurseryDispatchId = null;
      order.linkedNurseryTransportId = "";
      order.linkedNurseryDispatchDate = null;
    } else if (dispatchMode === "OFFICE") {
      order.vehicleId = null;
      order.vehicleNumber = "";
      order.driverName = "";
      order.driverMobile = "";
      order.linkedNurseryDispatchId = null;
      order.linkedNurseryTransportId = "";
      order.linkedNurseryDispatchDate = null;
      order.courierName = "";
      order.courierTrackingId = "";
      order.courierContact = "";
    }

    // Dispatch implies physically loaded for Ram Agri flow.
    order.agriLoadStatus = "LOADED";
    order.loadedAt = dispatchedAt;
    order.loadedBy = userId;

    // Build activity log description
    let stockInfo = "";
    if (shouldDeductStock && stockDeductionSuccess) {
      stockInfo = `. Stock deducted: ${stockBefore} → ${stockAfter}`;
    } else if (isAssignedOrder) {
      stockInfo = ". (Assigned order - stock not deducted)";
    }

    let activityDescription = "";
    let newValueData = { 
      orderStatus: "DISPATCHED",
      dispatchStatus: "DISPATCHED", 
      dispatchMode, 
      stockDeducted: stockDeductionSuccess,
      agriLoadStatus: "LOADED",
      loadedAt: dispatchedAt,
      loadedBy: userId,
    };

    if (dispatchMode === "VEHICLE" || dispatchMode === "WITH_ORDER") {
      const linkedTrail = linkedDispatchTrailByAgriOrderId.get(String(order._id));
      const vehicleLabel = order.vehicleNumber || finalVehicleNumber || "-";
      const driverLabel = order.driverName || finalDriverName || "-";
      const linkedTransportNote =
        dispatchMode === "WITH_ORDER" && linkedTrail?.linkedNurseryTransportId
          ? ` Linked regular dispatch #${linkedTrail.linkedNurseryTransportId}.`
          : "";
      activityDescription = `Order dispatched via vehicle ${vehicleLabel} (Driver: ${driverLabel}).${linkedTransportNote} Status: ${previousOrderStatus} → DISPATCHED${stockInfo}`;
      newValueData = {
        ...newValueData,
        vehicleNumber: order.vehicleNumber || finalVehicleNumber,
        driverName: order.driverName || finalDriverName,
        driverMobile: order.driverMobile || finalDriverMobile,
        linkedNurseryDispatchId: linkedTrail?.linkedNurseryDispatchId || null,
        linkedNurseryTransportId: linkedTrail?.linkedNurseryTransportId || "",
        linkedNurseryDispatchDate: linkedTrail?.linkedNurseryDispatchDate || null,
        stockBefore,
        stockAfter,
      };
    } else if (dispatchMode === "COURIER") {
      activityDescription = `Order dispatched via courier ${finalCourierName}${finalCourierTrackingId ? ` (Tracking: ${finalCourierTrackingId})` : ""}. Status: ${previousOrderStatus} → DISPATCHED${stockInfo}`;
      newValueData = {
        ...newValueData,
        courierName: finalCourierName,
        courierTrackingId: finalCourierTrackingId,
        courierContact: finalCourierContact,
        stockBefore,
        stockAfter,
      };
    } else if (dispatchMode === "OFFICE") {
      const remark = String(dispatchNotes || "").trim();
      activityDescription = `Order dispatched from office.${remark ? ` Remark: ${remark}.` : ""} Status: ${previousOrderStatus} → DISPATCHED${stockInfo}`;
      newValueData = {
        ...newValueData,
        dispatchNotes: remark,
        stockBefore,
        stockAfter,
      };
    }

    // Add activity log
    if (!order.activityLog) order.activityLog = [];
    order.activityLog.push({
      action: "ORDER_DISPATCHED",
      description: activityDescription,
      performedBy: userId,
      performedByName: userName,
      previousValue: { orderStatus: previousOrderStatus, dispatchStatus: previousDispatchStatus, stockDeducted: order.stockDeducted },
      newValue: newValueData,
      metadata: {
        dispatchMode,
        vehicleId:
          dispatchMode === "VEHICLE" || dispatchMode === "WITH_ORDER"
            ? vehicleId || null
            : null,
        linkedNurseryDispatchId: order.linkedNurseryDispatchId || null,
        linkedNurseryTransportId: order.linkedNurseryTransportId || "",
        linkedNurseryDispatchDate: order.linkedNurseryDispatchDate || null,
        dispatchNotes,
        dispatchedAt,
        agriLoadStatus: "LOADED",
        loadedAt: dispatchedAt,
        loadedBy: userId,
        wasAssignedOrder: isAssignedOrder,
        stockDeductedOnDispatch: shouldDeductStock && stockDeductionSuccess,
        stockDeduction: { stockBefore, stockAfter, quantityDeducted: order.quantity },
      },
    });

    await order.save();
    updatedOrders.push(order);
  }

  // Populate fields for response
  await AgriSalesOrder.populate(updatedOrders, [
    { path: "productId" },
    { path: "lineItems.productId" },
    { path: "lineItems.ramAgriCropId" },
    { path: "createdBy" },
    { path: "salesPerson", select: "name phoneNumber jobTitle" },
    { path: "dispatchedBy" },
    { path: "vehicleId" },
  ]);

  // Build response dispatch details
  const dispatchDetails = {
    dispatchMode,
    dispatchedAt,
    totalOrders: updatedOrders.length,
  };

  if (dispatchMode === "VEHICLE" || dispatchMode === "WITH_ORDER") {
    dispatchDetails.vehicleNumber = finalVehicleNumber;
    dispatchDetails.driverName = finalDriverName;
    dispatchDetails.driverMobile = finalDriverMobile;
    if (dispatchMode === "WITH_ORDER") {
      dispatchDetails.linkedWithRegularDispatch = true;
    }
  } else if (dispatchMode === "COURIER") {
    dispatchDetails.courierName = finalCourierName;
    dispatchDetails.courierTrackingId = finalCourierTrackingId;
    dispatchDetails.courierContact = finalCourierContact;
  } else if (dispatchMode === "OFFICE") {
    dispatchDetails.dispatchNotes = dispatchNotes || "";
    dispatchDetails.officeDispatch = true;
  }

  const response = generateResponse(
    "Success",
    `${updatedOrders.length} order(s) dispatched successfully via ${
      dispatchMode === "COURIER"
        ? "courier"
        : dispatchMode === "WITH_ORDER"
          ? "with linked regular order"
          : dispatchMode === "OFFICE"
            ? "office"
            : "vehicle"
    }`,
    {
      dispatchedOrders: updatedOrders,
      dispatchDetails,
    },
    undefined
  );

  return res.status(200).json(response);
});

// ==================== UPDATE DISPATCH STATUS ====================
// Update dispatch status (IN_TRANSIT, DELIVERED)

const updateDispatchStatus = catchAsync(async (req, res, next) => {
  const { id } = req.params;
  const { dispatchStatus, notes } = req.body;

  if (!mongoose.isValidObjectId(id)) {
    return next(new AppError("Invalid order ID format", 400));
  }

  if (!["IN_TRANSIT", "DELIVERED", "NOT_DISPATCHED"].includes(dispatchStatus)) {
    return next(new AppError("Invalid dispatch status. Must be IN_TRANSIT, DELIVERED, or NOT_DISPATCHED", 400));
  }

  const order = await AgriSalesOrder.findById(id);
  if (!order) {
    return next(new AppError("Order not found", 404));
  }

  // Get user info for activity log
  const userId = req.user?._id || req.user?.id;
  const userName = req.user?.name || "Unknown";

  const previousDispatchStatus = order.dispatchStatus;

  // Update dispatch status
  order.dispatchStatus = dispatchStatus;

  // If marking as delivered, update order status to COMPLETED
  if (dispatchStatus === "DELIVERED") {
    order.orderStatus = "COMPLETED";
  }

  // If reverting to NOT_DISPATCHED, clear dispatch info
  if (dispatchStatus === "NOT_DISPATCHED") {
    order.vehicleId = null;
    order.vehicleNumber = null;
    order.driverName = null;
    order.driverMobile = null;
    order.dispatchedAt = null;
    order.dispatchedBy = null;
    order.dispatchNotes = null;
  }

  // Add activity log
  if (!order.activityLog) order.activityLog = [];
  order.activityLog.push({
    action: "DISPATCH_UPDATED",
    description: `Dispatch status changed from ${previousDispatchStatus} to ${dispatchStatus}${notes ? `: ${notes}` : ""}`,
    performedBy: userId,
    performedByName: userName,
    previousValue: { dispatchStatus: previousDispatchStatus },
    newValue: { dispatchStatus },
    metadata: { notes },
  });

  await order.save();

  // Populate fields
  await order.populate("productId");
  await order.populate("createdBy");
  await order.populate("salesPerson", "name phoneNumber jobTitle");
  await order.populate("dispatchedBy");
  await order.populate("vehicleId");

  const response = generateResponse(
    "Success",
    `Dispatch status updated to ${dispatchStatus}`,
    order,
    undefined
  );

  return res.status(200).json(response);
});

// ==================== COMPLETE ORDERS (Mark as Delivered with Return Handling) ====================
// Complete dispatched orders with optional return quantity - adds returned stock back to inventory

const completeOrders = catchAsync(async (req, res, next) => {
  const {
    orderIds, // Array of order IDs to complete
    returnQuantities, // Object mapping orderId to return quantity { orderId: returnQty }
    returnReason, // Common reason for returns (optional)
    returnNotes, // Additional notes (optional)
  } = req.body;

  // Validate required fields
  if (!orderIds || !Array.isArray(orderIds) || orderIds.length === 0) {
    return next(new AppError("At least one order ID is required", 400));
  }

  // Validate all order IDs
  for (const orderId of orderIds) {
    if (!mongoose.isValidObjectId(orderId)) {
      return next(new AppError(`Invalid order ID format: ${orderId}`, 400));
    }
  }

  // Get user info for activity log
  const userId = req.user?._id || req.user?.id;
  const userName = req.user?.name || "Unknown";
  const userRole = req.user?.role;
  const userJobTitle = req.user?.jobTitle;

  // Determine if user is manager/admin (can return stock to warehouse)
  // Prioritize jobTitle over role
  const effectiveRole = userJobTitle || userRole;
  const isManager =
    effectiveRole === "SUPER_ADMIN" ||
    effectiveRole === "ADMIN" ||
    effectiveRole === "OFFICE_ADMIN" ||
    effectiveRole === "RAM_AGRI_SALES_MANAGER" ||
    effectiveRole === RAM_AGRI_SALES_OFFICE_MANAGER;

  // Find all orders that can be completed (must be dispatched)
  const orders = await AgriSalesOrder.find({
    _id: { $in: orderIds },
    $or: [
      { orderStatus: "DISPATCHED" },
      { dispatchStatus: { $in: ["DISPATCHED", "IN_TRANSIT"] } }
    ]
  });

  if (orders.length === 0) {
    return next(new AppError("No valid orders found for completion. Orders must be in DISPATCHED or IN_TRANSIT status.", 404));
  }

  const completedAt = new Date();
  const updatedOrders = [];
  const stockReturnResults = [];

  for (const order of orders) {
    const orderId = order._id.toString();
    const returnQty = returnQuantities?.[orderId] || 0;
    
    // Validate return quantity
    if (returnQty < 0) {
      return next(new AppError(`Return quantity cannot be negative for order ${order.orderNumber}`, 400));
    }
    if (returnQty > order.quantity) {
      return next(new AppError(`Return quantity (${returnQty}) cannot exceed order quantity (${order.quantity}) for order ${order.orderNumber}`, 400));
    }

    const previousDispatchStatus = order.dispatchStatus;
    const previousOrderStatus = order.orderStatus;
    let stockBefore = 0;
    let stockAfter = 0;
    let stockReturnSuccess = false;

    // Calculate delivered quantity
    const deliveredQty = order.quantity - returnQty;

    // Check if order was assigned to a sales person (sales person dispatched orders)
    const isAssignedOrder = order.assignedTo != null;
    
    // If dispatched by current user (e.g. from mobile), do NOT add/subtract stock (same as sales return).
    const wasDispatchedBySelf = order.dispatchedBy && order.dispatchedBy.toString() === userId.toString();

    // If there are returns, add stock back to inventory ONLY if:
    // 1. Current user is a MANAGER/ADMIN (not sales person)
    // 2. AND order was NOT assigned to a sales person (admin dispatched)
    // 3. AND order was NOT dispatched by current user (if sales person)
    // Only managers can return stock to warehouse - sales person returns don't impact warehouse stock
    const shouldAddStockBack = returnQty > 0 && isManager && !isAssignedOrder && (!wasDispatchedBySelf || isManager);
    
    if (shouldAddStockBack) {
      try {
        const lines = getAgriOrderLines(order);
        const perLineReturns = distributeReturnQtyAcrossLines(lines, returnQty);
        for (let li = 0; li < lines.length; li++) {
          const line = lines[li];
          const rq = perLineReturns[li] || 0;
          if (rq <= 0) continue;
          const rate = Number(line.rate) || 0;
          if (line.isRamAgriProduct || line.ramAgriCropId) {
            const crop = await RamAgriInputsProduct.findById(line.ramAgriCropId);
            if (!crop) continue;
            const variety = crop.varieties.id(line.ramAgriVarietyId);
            if (!variety) continue;
            stockBefore = variety.currentStock || 0;
            variety.currentStock = (variety.currentStock || 0) + rq;
            variety.stockValue = (variety.stockValue || 0) + rq * rate;
            if (variety.currentStock > 0) {
              variety.averagePrice = variety.stockValue / variety.currentStock;
            } else {
              variety.averagePrice = 0;
            }
            stockAfter = variety.currentStock;
            await crop.save();
            stockReturnSuccess = true;
          } else if (line.productId) {
            const product = await InventoryProduct.findById(line.productId);
            if (!product) continue;
            stockBefore = product.currentStock || 0;
            product.currentStock = (product.currentStock || 0) + rq;
            stockAfter = product.currentStock;
            await product.save();

            await InventoryOutwardTransaction.create({
              productId: line.productId,
              quantity: rq,
              sellingPrice: rate,
              totalAmount: rq * rate,
              customer: {
                name: order.customerName,
                contact: order.customerMobile,
              },
              purpose: "return",
              destination: "warehouse",
              outwardDate: new Date(),
              issuedBy: userId,
              notes: `Return from Ram Agri Sales Order: ${order.orderNumber}. Reason: ${returnReason || "Customer return"}`,
              status: "returned",
            });
            stockReturnSuccess = true;
          }
        }

        if (stockReturnSuccess) {
          order.stockReturned = true;
          order.stockReturnedAt = new Date();
        }
      } catch (stockError) {
        console.error(`Error returning stock for order ${order.orderNumber}:`, stockError);
        // Continue with completion even if stock return fails
      }
    } else if (returnQty > 0 && (!isManager || isAssignedOrder || wasDispatchedBySelf)) {
      // Sales person completing order with returns OR manager completing assigned order - no stock impact
      // Don't mark stockReturned = true since stock wasn't added back to warehouse
      order.stockReturned = false; // Explicitly set to false for sales person returns
      stockReturnSuccess = false;
    }

    stockReturnResults.push({
      orderId: order._id,
      orderNumber: order.orderNumber,
      originalQuantity: order.quantity,
      returnQuantity: returnQty,
      deliveredQuantity: deliveredQty,
      stockReturned: stockReturnSuccess,
      stockBefore,
      stockAfter,
    });

    // Update order fields
    order.dispatchStatus = "DELIVERED";
    order.orderStatus = "COMPLETED";
    order.completedAt = completedAt;
    order.completedBy = userId;
    order.returnQuantity = returnQty;
    order.deliveredQuantity = deliveredQty;
    order.returnReason = returnReason || "";
    order.returnNotes = returnNotes || "";

    const completionLines = getAgriOrderLines(order);
    const perLineReturns = distributeReturnQtyAcrossLines(completionLines, returnQty);
    if (Array.isArray(order.lineItems) && order.lineItems.length > 0) {
      order.lineItems.forEach((li, idx) => {
        const rq = perLineReturns[idx] || 0;
        li.returnQuantity = rq;
        li.deliveredQuantity = Math.max(0, (Number(li.quantity) || 0) - rq);
      });
    }
    
    // Store original quantity and previous values for ledger entry
    // IMPORTANT: Calculate previous values based on ORIGINAL quantity, not current order values
    // This ensures we get the correct previous balance even if order was modified before
    const originalQuantity = order.quantity || 0;
    const previousDeliveredQuantity = order.deliveredQuantity || originalQuantity;
    
    // Calculate previous totalAmount from ORIGINAL quantity (not from order.totalAmount which might be modified)
    // IMPORTANT: Always use originalQuantity * rate for previousTotalAmount to ensure correct calculation
    // even if order.totalAmount was modified in a previous operation
    const originalTotalAmount = completionLines.reduce(
      (sum, line) => sum + (Number(line.quantity) || 0) * (Number(line.rate) || 0),
      0
    );
    // For previousTotalAmount, use the original calculation UNLESS order was already completed
    // If order was already completed, use the current totalAmount as previous (it was already adjusted)
    const isAlreadyCompleted = order.orderStatus === "COMPLETED" || order.deliveredQuantity > 0;
    const previousTotalAmount = isAlreadyCompleted && order.totalAmount 
      ? order.totalAmount 
      : originalTotalAmount;
    
    // Calculate previous balance based on original totalAmount and current payments
    const previousTotalPaid = order.payment && order.payment.length > 0
      ? order.payment.reduce((sum, p) => {
          if (p.paymentStatus === "COLLECTED") {
            return sum + (p.paidAmount || 0);
          }
          return sum;
        }, 0)
      : 0;
    const previousBalanceAmount = previousTotalAmount - previousTotalPaid;
    
    // Recalculate totalAmount from per-line delivered qty (multi-product orders use line rates)
    let newTotalAmount = 0;
    completionLines.forEach((line, idx) => {
      const deliveredLineQty = Math.max(0, (Number(line.quantity) || 0) - (perLineReturns[idx] || 0));
      newTotalAmount += deliveredLineQty * (Number(line.rate) || 0);
    });
    order.totalAmount = newTotalAmount;
    order.rate = deliveredQty > 0 ? newTotalAmount / deliveredQty : order.rate || 0;
    
    // Recalculate balanceAmount based on new totalAmount
    const totalPaid = order.payment && order.payment.length > 0
      ? order.payment.reduce((sum, p) => {
          if (p.paymentStatus === "COLLECTED") {
            return sum + (p.paidAmount || 0);
          }
          return sum;
        }, 0)
      : 0;
    
    order.totalPaidAmount = totalPaid;
    order.balanceAmount = order.totalAmount - totalPaid;
    
    // Update payment status based on new balance
    if (order.balanceAmount <= 0) {
      order.paymentStatus = "COMPLETED";
    } else if (totalPaid > 0) {
      order.paymentStatus = "PARTIAL";
    } else {
      order.paymentStatus = "PENDING";
    }

    // Create ledger entry if quantity changed OR totalAmount changed OR balance changed
    // This ensures outstanding is adjusted when delivered quantity differs from original
    const quantityChanged = deliveredQty !== originalQuantity;
    const quantityReduced = deliveredQty < originalQuantity;
    const amountChanged = previousTotalAmount !== order.totalAmount;
    const balanceChanged = previousBalanceAmount !== order.balanceAmount;
    
    // Calculate differences
    const amountDifference = previousTotalAmount - order.totalAmount;
    const balanceDifference = previousBalanceAmount - order.balanceAmount;
    const outstandingReduction = balanceDifference > 0 ? balanceDifference : 0;
    
    // Debug logging
    console.log("🔍 Order Completion Ledger Debug:", {
      orderId: order._id,
      orderNumber: order.orderNumber,
      shouldLogRamAgriLedger: shouldLogRamAgriLedger(order),
      isRamAgriProduct: order.isRamAgriProduct,
      ramAgriCropId: order.ramAgriCropId,
      ramAgriVarietyId: order.ramAgriVarietyId,
      originalQuantity,
      deliveredQty,
      returnQty,
      quantityChanged,
      quantityReduced,
      previousTotalAmount,
      newTotalAmount: order.totalAmount,
      amountDifference,
      previousBalanceAmount,
      newBalanceAmount: order.balanceAmount,
      balanceDifference,
      outstandingReduction,
    });
    
    // Always create ledger entry if quantity is reduced OR amount changed OR outstanding changed
    // This ensures outstanding is properly tracked and adjusted when quantity is reduced
    // CRITICAL: Always create entry when quantity is reduced for RAM Agri orders
    const shouldCreateLedger = shouldLogRamAgriLedger(order);
    
    console.log("🔍 Ledger Creation Check:", {
      shouldCreateLedger,
      isRamAgriProduct: order.isRamAgriProduct,
      ramAgriCropId: order.ramAgriCropId,
      ramAgriVarietyId: order.ramAgriVarietyId,
      quantityReduced,
      amountChanged,
      balanceChanged,
      amountDifference,
      balanceDifference,
    });
    
    if (shouldCreateLedger) {
      // If quantity is reduced, we MUST create a ledger entry to adjust outstanding
      // ALWAYS create entry when quantity is reduced, regardless of other conditions
      // CRITICAL: If quantity is reduced, ALWAYS create ledger entry
      // This is the primary use case - when order is completed with returns
      if (quantityReduced || returnQty > 0) {
        // Quantity reduced OR returns exist - create CREDIT entry to reduce outstanding (customer owes less)
        // Calculate credit amount: prefer balanceDifference (outstanding reduction), then amountDifference, then returnQty * rate
        let creditToUse = 0;
        
        if (balanceDifference > 0) {
          // Outstanding was reduced - use the outstanding reduction amount
          creditToUse = outstandingReduction;
        } else if (amountDifference > 0) {
          // Amount was reduced - use the amount difference
          creditToUse = amountDifference;
        } else if (returnQty > 0 && (order.rate || 0) > 0) {
          // Amount difference is 0 but there are returns - use per-line rates
          creditToUse = computeAgriReturnCreditAmount(order, returnQty);
        }
        
        // ALWAYS create ledger entry when there are returns, even if calculated credit is 0
        if (creditToUse === 0 && returnQty > 0) {
          creditToUse = computeAgriReturnCreditAmount(order, returnQty);
        }
        
        // Create ledger entry if we have a valid credit amount
        if (creditToUse > 0) {
          try {
            console.log("📝 Creating ledger entry for order completion:", {
              orderId: order._id,
              orderNumber: order.orderNumber,
              creditAmount: creditToUse,
              balanceDifference,
              amountDifference,
              outstandingReduction,
              previousTotalAmount,
              newTotalAmount: order.totalAmount,
              previousBalanceAmount,
              newBalanceAmount: order.balanceAmount,
            });
            
            const ledgerEntry = await createCustomerLedgerEntry({
              customerMobile: order.customerMobile,
              customerName: order.customerName,
              refType: "ORDER_COMPLETION",
              refId: order._id,
              orderId: order._id,
              credit: creditToUse,
              reference: order.orderNumber,
              category: "Order Completion",
              description: `Order completed: Quantity reduced from ${originalQuantity} to ${deliveredQty} units. ${returnQty > 0 ? `Returned: ${returnQty} units. ` : ''}${balanceDifference > 0 ? `Outstanding reduced by ₹${outstandingReduction.toFixed(2)} (from ₹${previousBalanceAmount.toFixed(2)} to ₹${order.balanceAmount.toFixed(2)})` : `Amount reduced by ₹${amountDifference.toFixed(2)}. Outstanding: ₹${order.balanceAmount.toFixed(2)}`}`,
              entryDate: completedAt || new Date(),
              createdBy: userId,
              metadata: {
                originalQuantity: originalQuantity,
                previousDeliveredQuantity: previousDeliveredQuantity,
                deliveredQuantity: deliveredQty,
                returnQuantity: returnQty,
                previousTotalAmount,
                newTotalAmount: order.totalAmount,
                previousBalanceAmount,
                newBalanceAmount: order.balanceAmount,
                amountDifference,
                balanceDifference,
                outstandingReduction,
                returnReason: returnReason || "",
                returnNotes: returnNotes || "",
                quantityChanged,
                quantityReduced,
                amountChanged,
                balanceChanged,
              },
            });
            
            console.log("✅ Ledger entry created successfully:", ledgerEntry?._id || ledgerEntry?.id || "created");
          } catch (ledgerError) {
            console.error("❌ Error creating ledger entry for order completion (quantity reduced):", ledgerError);
            console.error("Error details:", {
              message: ledgerError.message,
              stack: ledgerError.stack,
              orderId: order._id,
              orderNumber: order.orderNumber,
            });
            // Don't fail the order completion if ledger entry fails, but log it
          }
        } else {
          console.error("❌ CRITICAL: Cannot create ledger entry - credit amount is 0 even after calculations!", {
            orderId: order._id,
            orderNumber: order.orderNumber,
            creditToUse,
            balanceDifference,
            amountDifference,
            outstandingReduction,
            originalQuantity,
            deliveredQty,
            returnQty,
            rate: order.rate,
            previousTotalAmount,
            newTotalAmount: order.totalAmount,
            previousBalanceAmount,
            newBalanceAmount: order.balanceAmount,
          });
        }
      } else if (amountDifference > 0) {
        // Amount decreased but no outstanding change (already paid) - still create entry for tracking
        try {
          await createCustomerLedgerEntry({
            customerMobile: order.customerMobile,
            customerName: order.customerName,
            refType: "ORDER_ADJUSTMENT",
            refId: order._id,
            orderId: order._id,
            credit: amountDifference,
            reference: order.orderNumber,
            category: "Order Adjustment",
            description: `Order completed with quantity change. Returned: ${returnQty} units. Final delivered: ${deliveredQty}/${originalQuantity} units. Amount reduced by ₹${amountDifference.toFixed(2)}. Outstanding: ₹${order.balanceAmount.toFixed(2)}`,
            entryDate: completedAt || new Date(),
            createdBy: userId,
            metadata: {
              originalQuantity: originalQuantity,
              previousDeliveredQuantity: previousDeliveredQuantity,
              deliveredQuantity: deliveredQty,
              returnQuantity: returnQty,
              previousTotalAmount,
              newTotalAmount: order.totalAmount,
              previousBalanceAmount,
              newBalanceAmount: order.balanceAmount,
              amountDifference,
              balanceDifference,
              returnReason: returnReason || "",
              returnNotes: returnNotes || "",
              quantityChanged,
              quantityReduced,
              amountChanged,
              balanceChanged,
            },
          });
        } catch (ledgerError) {
          console.error("Error creating ledger entry for order adjustment:", ledgerError);
        }
      } else if (amountDifference < 0) {
        // Amount increased - customer owes more, so DEBIT (unlikely with returns, but handle it)
        try {
          await createCustomerLedgerEntry({
            customerMobile: order.customerMobile,
            customerName: order.customerName,
            refType: "ORDER_ADJUSTMENT",
            refId: order._id,
            orderId: order._id,
            debit: Math.abs(amountDifference),
            reference: order.orderNumber,
            category: "Order Adjustment",
            description: `Order completed with quantity change. Amount increased by ₹${Math.abs(amountDifference).toFixed(2)}. Outstanding: ₹${order.balanceAmount.toFixed(2)}`,
            entryDate: completedAt || new Date(),
            createdBy: userId,
            metadata: {
              originalQuantity: originalQuantity,
              previousDeliveredQuantity: previousDeliveredQuantity,
              deliveredQuantity: deliveredQty,
              returnQuantity: returnQty,
              previousTotalAmount,
              newTotalAmount: order.totalAmount,
              previousBalanceAmount,
              newBalanceAmount: order.balanceAmount,
              amountDifference,
              balanceDifference,
              quantityChanged,
              quantityReduced,
              amountChanged,
              balanceChanged,
            },
          });
        } catch (ledgerError) {
          console.error("Error creating ledger entry for order adjustment:", ledgerError);
        }
      } else if (balanceChanged && !quantityReduced) {
        // Balance changed but quantity didn't reduce (payment-related change)
        try {
          await createCustomerLedgerEntry({
            customerMobile: order.customerMobile,
            customerName: order.customerName,
            refType: "BALANCE_ADJUSTMENT",
            refId: order._id,
            orderId: order._id,
            credit: balanceDifference > 0 ? balanceDifference : 0,
            debit: balanceDifference < 0 ? Math.abs(balanceDifference) : 0,
            reference: order.orderNumber,
            category: "Balance Adjustment",
            description: `Outstanding adjusted from ₹${previousBalanceAmount.toFixed(2)} to ₹${order.balanceAmount.toFixed(2)}`,
            entryDate: completedAt || new Date(),
            createdBy: userId,
            metadata: {
              previousBalanceAmount,
              newBalanceAmount: order.balanceAmount,
              balanceDifference,
              balanceChanged,
            },
          });
        } catch (ledgerError) {
          console.error("Error creating ledger entry for balance adjustment:", ledgerError);
        }
      }
    } // End of if (shouldLogRamAgriLedger(order))

    // Build activity log
    let activityDescription = `Order delivered and completed. Status: ${previousOrderStatus} → COMPLETED. Delivered: ${deliveredQty}/${order.quantity}`;
    if (returnQty > 0) {
      if (stockReturnSuccess) {
        // Stock was actually returned to inventory
        activityDescription += `. Returned: ${returnQty} (Stock: ${stockBefore} → ${stockAfter})`;
      } else if (isAssignedOrder || wasDispatchedBySelf) {
        // Sales person order - no stock impact
        activityDescription += `. Returned: ${returnQty} (No stock impact - Sales person order)`;
      } else {
        // Return attempted but stock return failed
        activityDescription += `. Returned: ${returnQty} (Stock return failed)`;
      }
      if (returnReason) {
        activityDescription += `. Reason: ${returnReason}`;
      }
    }
    // Add payment adjustment info if totalAmount changed
    if (previousTotalAmount !== order.totalAmount) {
      activityDescription += `. Payment adjusted: Total Amount updated from ₹${previousTotalAmount.toFixed(2)} to ₹${order.totalAmount.toFixed(2)} based on delivered quantity (${deliveredQty} × ₹${order.rate})`;
    }

    // Add activity log
    if (!order.activityLog) order.activityLog = [];
    order.activityLog.push({
      action: "ORDER_DELIVERED",
      description: activityDescription,
      performedBy: userId,
      performedByName: userName,
      previousValue: { 
        dispatchStatus: previousDispatchStatus, 
        orderStatus: previousOrderStatus 
      },
      newValue: { 
        dispatchStatus: "DELIVERED", 
        orderStatus: "COMPLETED",
        deliveredQuantity: deliveredQty,
        returnQuantity: returnQty,
        totalAmount: order.totalAmount,
        balanceAmount: order.balanceAmount,
      },
      metadata: {
        originalQuantity: order.quantity,
        deliveredQuantity: deliveredQty,
        returnQuantity: returnQty,
        returnReason,
        returnNotes,
        previousTotalAmount,
        newTotalAmount: order.totalAmount,
        stockReturn: returnQty > 0 ? { stockBefore, stockAfter, success: stockReturnSuccess } : null,
      },
    });

    // If stock was returned, add separate activity log entry
    if (returnQty > 0 && stockReturnSuccess) {
      order.activityLog.push({
        action: "STOCK_RETURNED",
        description: `${returnQty} units returned to inventory (Stock: ${stockBefore} → ${stockAfter})`,
        performedBy: userId,
        performedByName: userName,
        previousValue: { stock: stockBefore },
        newValue: { stock: stockAfter },
        metadata: {
          returnQuantity: returnQty,
          returnReason,
        },
      });
    }

    await order.save();
    updatedOrders.push(order);
  }

  // Populate fields for response
  await AgriSalesOrder.populate(updatedOrders, [
    { path: "productId" },
    { path: "createdBy" },
    { path: "salesPerson", select: "name phoneNumber jobTitle" },
    { path: "dispatchedBy" },
    { path: "completedBy" },
    { path: "vehicleId" },
  ]);

  const response = generateResponse(
    "Success",
    `${updatedOrders.length} order(s) completed successfully`,
    {
      orders: updatedOrders,
      summary: {
        totalCompleted: updatedOrders.length,
        totalReturns: stockReturnResults.filter(r => r.returnQuantity > 0).length,
        stockReturnResults,
      },
    },
    undefined
  );

  return res.status(200).json(response);
});

// ==================== PROCESS SALES RETURN (For Sales Person Dispatched Orders) ====================
// Process returns for orders dispatched by sales person - NO stock impact, but can adjust payments

const processSalesReturn = catchAsync(async (req, res, next) => {
  const { id } = req.params; // Order ID
  const {
    returnQuantity,
    returnReason,
    returnNotes,
    paymentAdjustments, // Array of payment adjustments: [{ amount: -100, adjustmentType: "REFUND", reason: "...", notes: "..." }]
  } = req.body;

  if (!mongoose.isValidObjectId(id)) {
    return next(new AppError("Invalid order ID format", 400));
  }

  const order = await AgriSalesOrder.findById(id);
  if (!order) {
    return next(new AppError("Order not found", 404));
  }

  // Validate: Only sales person who dispatched the order (or assigned order) can process returns
  // Prioritize jobTitle over role
  const userId = req.user?._id || req.user?.id;
  const userName = req.user?.name || "Unknown";
  const effectiveRole = req.user?.jobTitle || req.user?.role;
  const isAdmin =
    effectiveRole === "SUPER_ADMIN" ||
    effectiveRole === "ADMIN" ||
    effectiveRole === "OFFICE_ADMIN" ||
    effectiveRole === RAM_AGRI_SALES_OFFICE_MANAGER;
  const isAssignedOrder = order.assignedTo != null;
  const wasDispatchedBySalesPerson = order.dispatchedBy && order.dispatchedBy.toString() === userId.toString();

  // Only allow if:
  // 1. Order was assigned to the user and they dispatched it, OR
  // 2. Admin is processing return for any dispatched order
  if (!isAdmin && !(isAssignedOrder && wasDispatchedBySalesPerson)) {
    return next(new AppError("You can only process returns for orders you dispatched", 403));
  }

  // Order must be dispatched
  if (!order.dispatchedAt || order.dispatchStatus === "NOT_DISPATCHED") {
    return next(new AppError("Order must be dispatched before processing sales return", 400));
  }

  // Validate return quantity
  const returnQty = parseFloat(returnQuantity) || 0;
  if (returnQty < 0) {
    return next(new AppError("Return quantity cannot be negative", 400));
  }
  if (returnQty > order.quantity) {
    return next(new AppError(`Return quantity (${returnQty}) cannot exceed order quantity (${order.quantity})`, 400));
  }

  const previousSalesReturnQty = order.salesReturnQuantity || 0;
  const previousTotalPaid = order.totalPaidAmount || 0;

  // Update sales return fields
  order.salesReturnQuantity = returnQty;
  order.salesReturnReason = returnReason || "";
  order.salesReturnNotes = returnNotes || "";
  order.salesReturnedAt = new Date();
  order.salesReturnedBy = userId;

  // Calculate delivered quantity (considering sales return, but separate from regular return)
  const salesDeliveredQty = order.quantity - returnQty;

  // Process payment adjustments (if any)
  if (paymentAdjustments && Array.isArray(paymentAdjustments) && paymentAdjustments.length > 0) {
    if (!order.paymentAdjustments) {
      order.paymentAdjustments = [];
    }

    let totalAdjustment = 0;
    for (const adjustment of paymentAdjustments) {
      const { amount, adjustmentType, reason, notes, paymentId } = adjustment;
      
      if (typeof amount !== "number") {
        return next(new AppError("Payment adjustment amount must be a number", 400));
      }
      if (!["REFUND", "CREDIT", "ADJUSTMENT", "DEDUCTION"].includes(adjustmentType)) {
        return next(new AppError(`Invalid adjustment type: ${adjustmentType}`, 400));
      }

      order.paymentAdjustments.push({
        amount,
        adjustmentType,
        reason: reason || "",
        notes: notes || "",
        adjustedAt: new Date(),
        adjustedBy: userId,
        adjustedByName: userName,
        paymentId: paymentId || null,
      });

      totalAdjustment += amount; // amount can be negative for refunds

      // Create ledger entry for each payment adjustment
      if (shouldLogRamAgriLedger(order)) {
        try {
          // Positive amount = credit (customer paid more or refund reversed)
          // Negative amount = debit (refund given to customer)
          if (amount > 0) {
            await createCustomerLedgerEntry({
              customerMobile: order.customerMobile,
              customerName: order.customerName,
              refType: "PAYMENT_ADJUSTMENT",
              refId: order._id,
              orderId: order._id,
              paymentId: paymentId || null,
              credit: amount,
              reference: order.orderNumber,
              category: "Payment Adjustment",
              description: `Payment adjustment: ${adjustmentType} - ${reason || notes || "N/A"}`,
              entryDate: new Date(),
              createdBy: userId,
              metadata: {
                adjustmentType,
                reason: reason || "",
                notes: notes || "",
                paymentId: paymentId || null,
                salesReturnQuantity: returnQty,
              },
            });
          } else if (amount < 0) {
            await createCustomerLedgerEntry({
              customerMobile: order.customerMobile,
              customerName: order.customerName,
              refType: "PAYMENT_ADJUSTMENT",
              refId: order._id,
              orderId: order._id,
              paymentId: paymentId || null,
              debit: Math.abs(amount),
              reference: order.orderNumber,
              category: "Payment Adjustment",
              description: `Payment adjustment: ${adjustmentType} - ${reason || notes || "N/A"}`,
              entryDate: new Date(),
              createdBy: userId,
              metadata: {
                adjustmentType,
                reason: reason || "",
                notes: notes || "",
                paymentId: paymentId || null,
                salesReturnQuantity: returnQty,
              },
            });
          }
        } catch (ledgerError) {
          console.error("Error creating ledger entry for payment adjustment:", ledgerError);
          // Don't fail the sales return if ledger entry fails, but log it
        }
      }
    }

    // Update total paid amount (adjustments can be negative)
    order.totalPaidAmount = Math.max(0, previousTotalPaid + totalAdjustment);
    order.balanceAmount = order.totalAmount - order.totalPaidAmount;

    // Update payment status
    if (order.totalPaidAmount === 0) {
      order.paymentStatus = "PENDING";
    } else if (order.totalPaidAmount >= order.totalAmount) {
      order.paymentStatus = "COMPLETED";
    } else {
      order.paymentStatus = "PARTIAL";
    }
  }

  // Build activity log description
  let activityDescription = `Sales return processed. Returned: ${returnQty}/${order.quantity}. Delivered: ${salesDeliveredQty}. `;
  if (returnReason) {
    activityDescription += `Reason: ${returnReason}. `;
  }
  if (paymentAdjustments && paymentAdjustments.length > 0) {
    const totalAdjustment = paymentAdjustments.reduce((sum, adj) => sum + adj.amount, 0);
    activityDescription += `Payment adjusted: ${previousTotalPaid} → ${order.totalPaidAmount} (${totalAdjustment >= 0 ? '+' : ''}${totalAdjustment.toFixed(2)}). `;
  }
  activityDescription += `(NO stock impact - order was dispatched by sales person)`;

  // Add activity log
  if (!order.activityLog) order.activityLog = [];
  
  // Log sales return
  order.activityLog.push({
    action: "SALES_RETURN_PROCESSED",
    description: activityDescription,
    performedBy: userId,
    performedByName: userName,
    previousValue: {
      salesReturnQuantity: previousSalesReturnQty,
      totalPaidAmount: previousTotalPaid,
      paymentStatus: order.paymentStatus, // Will be updated below if adjustments exist
    },
    newValue: {
      salesReturnQuantity: returnQty,
      salesDeliveredQuantity: salesDeliveredQty,
      totalPaidAmount: order.totalPaidAmount,
      paymentStatus: order.paymentStatus,
    },
    metadata: {
      returnReason,
      returnNotes,
      isAssignedOrder,
      dispatchedBy: order.dispatchedBy,
    },
  });

  // Log payment adjustments separately if any
  if (paymentAdjustments && paymentAdjustments.length > 0) {
    for (const adjustment of paymentAdjustments) {
      order.activityLog.push({
        action: "PAYMENT_ADJUSTED",
        description: `Payment ${adjustment.adjustmentType.toLowerCase()}: ${adjustment.amount >= 0 ? '+' : ''}${adjustment.amount.toFixed(2)}. ${adjustment.reason || ""} ${adjustment.notes || ""}`.trim(),
        performedBy: userId,
        performedByName: userName,
        previousValue: {
          totalPaidAmount: previousTotalPaid,
        },
        newValue: {
          totalPaidAmount: order.totalPaidAmount,
          adjustmentAmount: adjustment.amount,
          adjustmentType: adjustment.adjustmentType,
        },
        metadata: {
          reason: adjustment.reason,
          notes: adjustment.notes,
          paymentId: adjustment.paymentId,
        },
      });
    }
  }

  await order.save();

  // Populate fields for response
  await order.populate("productId");
  await order.populate("createdBy");
  await order.populate("salesPerson", "name phoneNumber jobTitle");
  await order.populate("dispatchedBy");
  await order.populate("assignedTo");
  await order.populate("salesReturnedBy");

  const response = generateResponse(
    "Success",
    "Sales return processed successfully",
    {
      order,
      summary: {
        returnQuantity: returnQty,
        deliveredQuantity: salesDeliveredQty,
        originalQuantity: order.quantity,
        paymentAdjustments: paymentAdjustments?.length || 0,
        previousTotalPaid: previousTotalPaid,
        newTotalPaid: order.totalPaidAmount,
      },
    },
    undefined
  );

  return res.status(200).json(response);
});

// ==================== GET ORDERS FOR DISPATCH ====================
// Get orders that are ready for dispatch (ACCEPTED status, not yet dispatched)

const getOrdersForDispatch = catchAsync(async (req, res, next) => {
  const {
    page = 1,
    limit = 100,
    search,
    customerVillage,
    customerTaluka,
    customerDistrict,
    startDate,
    endDate,
  } = req.query;

  let query = AgriSalesOrder.find({
    orderStatus: "ACCEPTED",
    dispatchStatus: "NOT_DISPATCHED",
  });

  // Search filter
  if (search) {
    const searchRegex = new RegExp(search, "i");
    query = query.or([
      { customerName: searchRegex },
      { customerMobile: searchRegex },
      { orderNumber: searchRegex },
      { productName: searchRegex },
    ]);
  }

  // Location filters
  if (customerVillage) {
    query = query.where("customerVillage").equals(customerVillage);
  }
  if (customerTaluka) {
    query = query.where("customerTaluka").equals(customerTaluka);
  }
  if (customerDistrict) {
    query = query.where("customerDistrict").equals(customerDistrict);
  }

  // Date range filter
  if (startDate || endDate) {
    if (startDate && endDate) {
      const start = new Date(startDate);
      start.setHours(0, 0, 0, 0);
      const end = new Date(endDate);
      end.setHours(23, 59, 59, 999);
      query = query.where("orderDate").gte(start).lte(end);
    } else if (startDate) {
      const start = new Date(startDate);
      start.setHours(0, 0, 0, 0);
      query = query.where("orderDate").gte(start);
    } else if (endDate) {
      const end = new Date(endDate);
      end.setHours(23, 59, 59, 999);
      query = query.where("orderDate").lte(end);
    }
  }

  // Sort by order date
  query = query.sort({ orderDate: -1 });

  // Pagination
  const skip = (parseInt(page) - 1) * parseInt(limit);
  query = query.skip(skip).limit(parseInt(limit));

  // Populate references
  query = query
    .populate("productId")
    .populate("createdBy")
    .populate("salesPerson", "name phoneNumber jobTitle");

  const [orders, total] = await Promise.all([
    query.exec(),
    AgriSalesOrder.countDocuments(query.getFilter()),
  ]);

  const response = generateResponse(
    "Success",
    "Orders for dispatch fetched successfully",
    {
      data: orders,
      pagination: {
        total,
        page: parseInt(page),
        limit: parseInt(limit),
        pages: Math.ceil(total / parseInt(limit)),
      },
    },
    undefined
  );

  return res.status(200).json(response);
});

// ==================== GET DISPATCHED ORDERS ====================
// Get orders that have been dispatched

const getDispatchedOrders = catchAsync(async (req, res, next) => {
  const {
    page = 1,
    limit = 100,
    search,
    dispatchStatus, // DISPATCHED, IN_TRANSIT, DELIVERED
    startDate,
    endDate,
  } = req.query;

  let query = AgriSalesOrder.find({
    dispatchStatus: { $ne: "NOT_DISPATCHED" },
  });

  // Filter by specific dispatch status
  if (dispatchStatus && ["DISPATCHED", "IN_TRANSIT", "DELIVERED"].includes(dispatchStatus)) {
    query = query.where("dispatchStatus").equals(dispatchStatus);
  }

  // Search filter
  if (search) {
    const searchRegex = new RegExp(search, "i");
    query = query.or([
      { customerName: searchRegex },
      { customerMobile: searchRegex },
      { orderNumber: searchRegex },
      { productName: searchRegex },
      { vehicleNumber: searchRegex },
      { driverName: searchRegex },
    ]);
  }

  // Date range filter (by dispatch date)
  if (startDate || endDate) {
    if (startDate && endDate) {
      const start = new Date(startDate);
      start.setHours(0, 0, 0, 0);
      const end = new Date(endDate);
      end.setHours(23, 59, 59, 999);
      query = query.where("dispatchedAt").gte(start).lte(end);
    } else if (startDate) {
      const start = new Date(startDate);
      start.setHours(0, 0, 0, 0);
      query = query.where("dispatchedAt").gte(start);
    } else if (endDate) {
      const end = new Date(endDate);
      end.setHours(23, 59, 59, 999);
      query = query.where("dispatchedAt").lte(end);
    }
  }

  // Sort by dispatch date
  query = query.sort({ dispatchedAt: -1 });

  // Pagination
  const skip = (parseInt(page) - 1) * parseInt(limit);
  query = query.skip(skip).limit(parseInt(limit));

  // Populate references
  query = query
    .populate("productId")
    .populate("createdBy")
    .populate("salesPerson", "name phoneNumber jobTitle")
    .populate("dispatchedBy")
    .populate("vehicleId");

  const [orders, total] = await Promise.all([
    query.exec(),
    AgriSalesOrder.countDocuments(query.getFilter()),
  ]);

  const response = generateResponse(
    "Success",
    "Dispatched orders fetched successfully",
    {
      data: orders,
      pagination: {
        total,
        page: parseInt(page),
        limit: parseInt(limit),
        pages: Math.ceil(total / parseInt(limit)),
      },
    },
    undefined
  );

  return res.status(200).json(response);
});

function isRamAgriOutstandingLimitAdmin(user) {
  const j = String(user?.jobTitle || "")
    .toUpperCase()
    .trim();
  const r = String(user?.role || "")
    .toUpperCase()
    .trim();
  const set = new Set([
    "SUPER_ADMIN",
    "ADMIN",
    "OFFICE_ADMIN",
    "RAM_AGRI_SALES_MANAGER",
    RAM_AGRI_SALES_OFFICE_MANAGER,
  ]);
  return set.has(j) || set.has(r);
}

const getRamAgriOutstandingLimitSummary = catchAsync(async (req, res, next) => {
  let targetId = req.user._id || req.user.id;
  const q = req.query?.userId;
  if (q && String(q).trim()) {
    if (!isRamAgriOutstandingLimitAdmin(req.user)) {
      return next(new AppError("Only admins can view another user's outstanding summary", 403));
    }
    if (!mongoose.isValidObjectId(q)) {
      return next(new AppError("Invalid userId", 400));
    }
    targetId = q;
  }
  const summary = await getOutstandingSummaryForSalesUser(targetId);
  const u = await User.findById(targetId).select("ramAgriOutstandingLimitRupees name jobTitle").lean();
  return res.status(200).json(
    generateResponse("Success", "Outstanding limit summary", {
      ...summary,
      userId: targetId,
      userName: u?.name,
      limitOverrideRupees: u?.ramAgriOutstandingLimitRupees ?? null,
    })
  );
});

const getRamAgriOutstandingLimitSettings = catchAsync(async (req, res, next) => {
  if (!isRamAgriOutstandingLimitAdmin(req.user)) {
    return next(new AppError("Forbidden", 403));
  }
  const cfg = await getOrCreateRamAgriSalesConfig();
  const salesUsers = await User.find({
    $or: [{ jobTitle: "RAM_AGRI_SALES" }, { role: "RAM_AGRI_SALES" }],
    isDisabled: { $ne: true },
  })
    .select("name phoneNumber jobTitle role ramAgriOutstandingLimitRupees")
    .sort({ name: 1 })
    .lean();
  const globalDefault = Number(cfg.defaultOutstandingLimitRupees) || 10000;
  const withEffective = await Promise.all(
    salesUsers.map(async (u) => ({
      ...u,
      effectiveLimitRupees: await getEffectiveOutstandingLimitRupees(u._id),
    }))
  );
  return res.status(200).json(
    generateResponse("Success", "Ram Agri outstanding limit settings", {
      defaultOutstandingLimitRupees: globalDefault,
      salesUsers: withEffective,
    })
  );
});

const patchRamAgriOutstandingLimitGlobal = catchAsync(async (req, res, next) => {
  if (!isRamAgriOutstandingLimitAdmin(req.user)) {
    return next(new AppError("Forbidden", 403));
  }
  const v = req.body?.defaultOutstandingLimitRupees;
  await setGlobalDefaultOutstandingLimitRupees(v, req.user?._id || req.user?.id);
  const cfg = await getOrCreateRamAgriSalesConfig();
  return res.status(200).json(generateResponse("Success", "Global limit updated", cfg));
});

const patchRamAgriOutstandingLimitUser = catchAsync(async (req, res, next) => {
  if (!isRamAgriOutstandingLimitAdmin(req.user)) {
    return next(new AppError("Forbidden", 403));
  }
  const { userId } = req.params;
  if (!mongoose.isValidObjectId(userId)) {
    return next(new AppError("Invalid user ID", 400));
  }
  if (!Object.prototype.hasOwnProperty.call(req.body || {}, "ramAgriOutstandingLimitRupees")) {
    return next(new AppError("Body must include ramAgriOutstandingLimitRupees (number or null to clear)", 400));
  }
  const userBefore = await User.findById(userId).select("_id");
  if (!userBefore) return next(new AppError("User not found", 404));
  const raw = req.body.ramAgriOutstandingLimitRupees;
  if (raw === null || raw === undefined || raw === "") {
    await User.findByIdAndUpdate(userId, { $set: { ramAgriOutstandingLimitRupees: null } });
  } else {
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) {
      return next(
        new AppError("ramAgriOutstandingLimitRupees must be a non-negative number or null to clear", 400)
      );
    }
    await User.findByIdAndUpdate(userId, { $set: { ramAgriOutstandingLimitRupees: n } });
  }
  const user = await User.findById(userId).select("name ramAgriOutstandingLimitRupees jobTitle role");
  const effectiveLimitRupees = await getEffectiveOutstandingLimitRupees(user._id);
  return res.status(200).json(
    generateResponse("Success", "User limit updated", {
      ...user.toObject(),
      effectiveLimitRupees,
    })
  );
});

export {
  createAgriSalesOrder,
  createLinkedAgriOrderFromNurseryOrder,
  updateAgriSalesOrder,
  acceptAgriSalesOrder,
  rejectAgriSalesOrder,
  cancelAgriSalesOrder,
  getAllAgriSalesOrders,
  getOutstandingAgriSalesOrders,
  getAgriSalesOrderById,
  addPaymentToAgriSalesOrder,
  generatePaymentQRAgri,
  updatePaymentStatus,
  getCustomerByMobile,
  getPendingPayments,
  getPendingPaymentsCount,
  getOutstandingAnalysis,
  getSalesAnalysis,
  getCustomerOutstanding,
  assignOrdersToSalesPerson,
  getAssignedOrders,
  cancelAssignment,
  dispatchOrders,
  updateDispatchStatus,
  completeOrders,
  processSalesReturn,
  getOrdersForDispatch,
  getDispatchedOrders,
  markLinkedAgriLoaded,
  markLinkedAgriLoadedViaLink,
  getLinkedOrdersByNurseryOrder,
  getTodayPendingLinkedLoads,
  getDispatchLoadStatus,
  getRamAgriOutstandingLimitSummary,
  getRamAgriOutstandingLimitSettings,
  patchRamAgriOutstandingLimitGlobal,
  patchRamAgriOutstandingLimitUser,
};


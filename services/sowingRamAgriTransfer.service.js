/**
 * Internal stock transfer: Ram Agri Input → Ram Biotech nursery inventory
 * when sowing packet requests exceed Biotech warehouse stock.
 */
import mongoose from "mongoose";
import PurchaseOrder from "../models/purchaseOrder.model.js";
import GRN from "../models/grn.model.js";
import Product from "../models/product.model.js";
import Batch from "../models/batch.model.js";
import InventoryTransaction from "../models/inventoryTransaction.model.js";
import Supplier from "../models/supplier.model.js";
import RamAgriInputsProduct from "../models/ramAgriInputsProduct.model.js";
import {
  deductStockFIFO,
  toPrimaryUnitQuantity,
  returnToSourceBatches,
} from "./ramAgriBatchInventory.service.js";
import { resolveRamAgriForSeedProduct } from "./ramAgriVarietyInventoryLink.service.js";

const TRANSFER_NOTE_PREFIX = "biotechTransferAlloc:";

export async function getAvailablePacketsForProduct(product) {
  if (!product?._id) return 0;

  const batches = await Batch.find({
    product: product._id,
    status: { $in: ["active", "expired"] },
    remainingQuantity: { $gt: 0 },
  })
    .select("remainingQuantity unit")
    .populate("unit", "_id")
    .lean();

  const primaryUnitId = product.primaryUnit?._id?.toString() || String(product.primaryUnit || "");
  const secondaryUnitId =
    product.secondaryUnit?._id?.toString() || String(product.secondaryUnit || "");
  const cf = Number(product.conversionFactor) || 1;

  let total = 0;
  for (const batch of batches) {
    const batchUnitId = batch.unit?._id?.toString() || String(batch.unit || "");
    if (primaryUnitId && batchUnitId === primaryUnitId) {
      total += Number(batch.remainingQuantity) || 0;
    } else if (secondaryUnitId && batchUnitId === secondaryUnitId && cf > 0) {
      total += (Number(batch.remainingQuantity) || 0) / cf;
    } else {
      total += Number(batch.remainingQuantity) || 0;
    }
  }
  return Number(total.toFixed(4));
}

async function resolveRamAgriSupplier() {
  const envId = process.env.RAM_AGRI_SUPPLIER_ID;
  if (envId && mongoose.isValidObjectId(envId)) {
    const s = await Supplier.findById(envId).lean();
    if (s) return s;
  }
  const byName = await Supplier.findOne({
    isActive: { $ne: false },
    name: { $regex: /ram\s*agri/i },
  }).lean();
  if (byName) return byName;
  throw new Error(
    'Ram Agri supplier not found. Create a supplier named "Ram Agri" or set RAM_AGRI_SUPPLIER_ID.'
  );
}

async function generateClassicBatchNumber(productId) {
  const product = await Product.findById(productId).select("name code").lean();
  const productName = product?.name || product?.code || "PROD";
  const date = new Date();
  const year = date.getFullYear().toString().slice(-2);
  const month = (date.getMonth() + 1).toString().padStart(2, "0");
  const day = date.getDate().toString().padStart(2, "0");
  const productCode = productName.substring(0, 3).toUpperCase().replace(/\s/g, "");
  const random = Math.floor(Math.random() * 1000)
    .toString()
    .padStart(3, "0");
  let batchNumber = `BT${productCode}${year}${month}${day}${random}`;
  const clash = await Batch.findOne({ batchNumber }).select("_id").lean();
  if (clash) batchNumber = `${batchNumber}_${Date.now().toString().slice(-6)}`;
  return batchNumber;
}

function encodeTransferAlloc(allocations, cropId, varietyId) {
  return `${TRANSFER_NOTE_PREFIX}${JSON.stringify({
    cropId: String(cropId),
    varietyId: String(varietyId),
    allocations,
  })}`;
}

export function parseTransferAllocFromNotes(notes) {
  const raw = String(notes || "");
  if (!raw.startsWith(TRANSFER_NOTE_PREFIX)) return null;
  try {
    return JSON.parse(raw.slice(TRANSFER_NOTE_PREFIX.length));
  } catch {
    return null;
  }
}

/** Deduct Ram Agri + inward classic batch on Biotech product. */
export async function processBiotechTransferGrnItem(item, grn, poItem, userId) {
  if (!item.isRamAgriProduct || !poItem?.isBiotechTransfer || !poItem?.targetProduct) {
    return null;
  }

  const cropId = item.ramAgriCropId;
  const varietyId = item.ramAgriVarietyId;
  const targetProductId = poItem.targetProduct;

  const crop = await RamAgriInputsProduct.findById(cropId).populate(
    "varieties.primaryUnit varieties.secondaryUnit"
  );
  if (!crop) throw new Error("Ram Agri crop not found for transfer");
  const variety = crop.varieties.id(varietyId);
  if (!variety) throw new Error("Ram Agri variety not found for transfer");

  const qtyPrimary = toPrimaryUnitQuantity(item, variety);
  const deduct = await deductStockFIFO(cropId, varietyId, qtyPrimary, {
    userId,
    referenceNumber: grn.grnNumber,
    referenceType: "BiotechTransfer",
    referenceId: grn._id,
    movementType: "SOWING_RAISING_OUT",
    description: `Raising / sowing transfer — GRN ${grn.grnNumber || ""}`.trim(),
  });
  if (!deduct.ok) {
    throw new Error(deduct.error || "Insufficient Ram Agri stock for internal transfer");
  }

  const product = await Product.findById(targetProductId);
  if (!product) throw new Error("Target nursery seed product not found");

  const batchNumber = await generateClassicBatchNumber(targetProductId);
  const batch = await Batch.create({
    batchNumber,
    product: targetProductId,
    receivedDate: grn.grnDate || new Date(),
    supplier: grn.supplier,
    purchasePrice: Number(item.rate) || 0,
    quantity: item.acceptedQuantity,
    remainingQuantity: item.acceptedQuantity,
    unit: item.unit,
    grn: grn._id,
    notes: encodeTransferAlloc(deduct.allocations, cropId, varietyId),
    createdBy: userId,
  });

  const balanceBefore = Number(product.currentStock) || 0;
  product.currentStock = balanceBefore + item.acceptedQuantity;
  product.stockValue = (Number(product.stockValue) || 0) + (Number(item.amount) || 0);
  product.averagePrice =
    product.currentStock > 0 ? product.stockValue / product.currentStock : 0;
  product.updatedBy = userId;
  await product.save({ validateBeforeSave: false });

  const txnNumber = await InventoryTransaction.generateTransactionNumber();
  await InventoryTransaction.create({
    transactionNumber: txnNumber,
    transactionType: "inward",
    product: targetProductId,
    batch: batch._id,
    quantity: item.acceptedQuantity,
    unit: item.unit,
    balanceBeforeTransaction: balanceBefore,
    balanceAfterTransaction: product.currentStock,
    rate: item.rate,
    value: item.amount,
    referenceType: "GRN",
    referenceId: grn._id,
    referenceNumber: grn.grnNumber,
    toLocation: "Main Warehouse",
    reason: "Ram Agri → Ram Biotech internal transfer (sowing)",
    performedBy: userId,
    metadata: {
      isBiotechTransfer: true,
      ramAgriCropId: cropId,
      ramAgriVarietyId: varietyId,
    },
  });

  item.product = targetProductId;
  item.batch = batch._id;
  item.batchNumber = batchNumber;
  return batch;
}

async function approveGrnWithBiotechTransfer(grn, purchaseOrder, userId) {
  for (const item of grn.items) {
    if (!(item.acceptedQuantity > 0)) continue;

    const poItem = purchaseOrder.items.id(item.poItem) ||
      purchaseOrder.items.find(
        (pi) =>
          pi.isBiotechTransfer &&
          String(pi.ramAgriCropId) === String(item.ramAgriCropId) &&
          String(pi.ramAgriVarietyId) === String(item.ramAgriVarietyId)
      );

    if (poItem?.isBiotechTransfer) {
      await processBiotechTransferGrnItem(item, grn, poItem, userId);
    }
  }

  grn.status = "approved";
  grn.approvedBy = userId;
  grn.approvedDate = new Date();
  grn.markModified("items");
  await grn.save();
}

/**
 * Create + auto-approve internal PO when sowing request needs more company packets than in stock.
 */
export async function maybeCreateSowingTransferPurchaseOrder({
  product,
  companyPackets,
  sowingRequest,
  userId,
}) {
  const qty = Number(companyPackets) || 0;
  if (qty <= 0) return null;

  const available = await getAvailablePacketsForProduct(product);
  const shortfall = Number(Math.max(0, qty - available).toFixed(4));
  if (shortfall <= 0.001) return null;

  const productForResolve = {
    ...product,
    plantId: product?.plantId || sowingRequest?.plantId,
    subtypeId: product?.subtypeId || sowingRequest?.subtypeId,
  };
  const resolved = await resolveRamAgriForSeedProduct(productForResolve);
  if (!resolved?.cropId || !resolved?.varietyId) {
    return {
      skipped: true,
      reason: "No Ram Agri variety mapped for this seed packing",
      shortfall,
      available,
    };
  }

  const crop =
    resolved.crop ||
    (await RamAgriInputsProduct.findById(resolved.cropId).populate(
      "varieties.primaryUnit varieties.secondaryUnit"
    ));
  const variety = resolved.variety || crop?.varieties?.id(resolved.varietyId);
  if (!crop || !variety) {
    return { skipped: true, reason: "Ram Agri crop/variety not found", shortfall, available };
  }

  const supplier = await resolveRamAgriSupplier();
  const rate =
    Number(variety.averagePrice) ||
    Number(variety.purchasePrice) ||
    Number(variety.defaultRate) ||
    0;
  const amount = shortfall * rate;
  const primaryUnit = variety.primaryUnit?._id || variety.primaryUnit;

  const poNumber = await PurchaseOrder.generatePONumber();
  const poItem = {
    isRamAgriProduct: true,
    isBiotechTransfer: true,
    targetProduct: product._id,
    ramAgriCropId: resolved.cropId,
    ramAgriVarietyId: resolved.varietyId,
    ramAgriCropName: crop.cropName,
    ramAgriVarietyName: variety.name,
    quantity: shortfall,
    unit: primaryUnit,
    rate,
    gst: 0,
    discount: 0,
    amount,
    selectedUnitType: "primary",
    conversionFactor: variety.conversionFactor || 1,
    notes: `Sowing transfer for ${sowingRequest.requestNumber}`,
  };

  const purchaseOrder = new PurchaseOrder({
    poNumber,
    supplier: supplier._id,
    poDate: new Date(),
    expectedDeliveryDate: new Date(),
    items: [poItem],
    subtotal: amount,
    gstAmount: 0,
    discountAmount: 0,
    otherCharges: 0,
    totalAmount: amount,
    status: "pending",
    autoGRN: true,
    isInternalTransfer: true,
    sowingRequestId: sowingRequest._id,
    supplierInvoiceNumber: `SR-${sowingRequest.requestNumber}`,
    supplierInvoiceFile: {
      url: "internal://sowing-transfer",
      originalName: "internal-transfer.txt",
      mimeType: "text/plain",
      uploadedAt: new Date(),
    },
    notes: `Auto internal transfer Ram Agri → Ram Biotech for sowing ${sowingRequest.requestNumber}`,
    createdBy: userId,
  });

  purchaseOrder.status = "approved";
  purchaseOrder.approvedBy = userId;
  purchaseOrder.approvedDate = new Date();
  await purchaseOrder.save();

  const grnNumber = await GRN.generateGRNNumber();
  const savedPoItem = purchaseOrder.items[0];
  const grnItem = {
    poItem: savedPoItem._id,
    isRamAgriProduct: true,
    ramAgriCropId: resolved.cropId,
    ramAgriVarietyId: resolved.varietyId,
    ramAgriCropName: crop.cropName,
    ramAgriVarietyName: variety.name,
    quantity: shortfall,
    unit: primaryUnit,
    rate,
    acceptedQuantity: shortfall,
    rejectedQuantity: 0,
    damageQuantity: 0,
    amount,
    selectedUnitType: "primary",
    conversionFactor: variety.conversionFactor || 1,
  };

  const grn = new GRN({
    grnNumber,
    supplier: supplier._id,
    purchaseOrder: purchaseOrder._id,
    grnDate: new Date(),
    items: [grnItem],
    subtotal: amount,
    gstAmount: 0,
    freightCharges: 0,
    otherCharges: 0,
    totalAmount: amount,
    status: "draft",
    notes: `Auto transfer GRN for sowing ${sowingRequest.requestNumber}`,
    createdBy: userId,
  });
  await grn.save();

  await approveGrnWithBiotechTransfer(grn, purchaseOrder, userId);

  purchaseOrder.status = "received";
  purchaseOrder.updatedBy = userId;
  await purchaseOrder.save();

  return {
    purchaseOrder,
    grn,
    shortfall,
    availableBefore: available,
  };
}

/** Restore Ram Agri stock when Biotech returns unused sowing packets (sales-return equivalent). */
export async function restoreRamAgriFromBiotechReturn(returnRequest, userId) {
  if (!returnRequest?.batch) return { restored: false };

  const batch = await Batch.findById(returnRequest.batch).select("notes product").lean();
  if (!batch) return { restored: false };

  const meta = parseTransferAllocFromNotes(batch.notes);
  if (!meta?.allocations?.length) return { restored: false };

  const qty = Number(returnRequest.quantity) || 0;
  if (qty <= 0) return { restored: false };

  const result = await returnToSourceBatches(meta.allocations, qty, {
    cropId: meta.cropId,
    varietyId: meta.varietyId,
    userId,
  });

  if (!result.ok) {
    console.error("[BiotechReturn] Ram Agri restore failed:", result.error);
    return { restored: false, error: result.error };
  }

  return {
    restored: true,
    ramAgriRestored: result.restored,
    cropId: meta.cropId,
    varietyId: meta.varietyId,
  };
}

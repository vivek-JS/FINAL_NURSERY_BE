import mongoose from 'mongoose';
import RamAgriBatch from '../models/ramAgriBatch.model.js';
import RamAgriInputsProduct from '../models/ramAgriInputsProduct.model.js';

/** Convert inbound qty to primary unit using item/variety conversion fields. */
export function toPrimaryUnitQuantity(item, variety) {
  let qty = Number(item.acceptedQuantity ?? item.quantity) || 0;
  if (item.selectedUnitType === 'secondary' && item.conversionFactor > 0) {
    return qty * Number(item.conversionFactor);
  }
  const itemUnitId = item.unit?._id?.toString() || item.unit?.toString() || item.unit;
  const secondaryId =
    variety.secondaryUnit?._id?.toString() ||
    variety.secondaryUnit?.toString() ||
    variety.secondaryUnit;
  if (
    secondaryId &&
    itemUnitId &&
    itemUnitId.toString() === secondaryId.toString() &&
    variety.conversionFactor > 0
  ) {
    return qty * Number(variety.conversionFactor);
  }
  return qty;
}

export async function generateRamAgriBatchNumber(cropName = 'CRP', varietyName = 'VAR', cropId = null) {
  const date = new Date();
  const year = date.getFullYear().toString().slice(-2);
  const month = (date.getMonth() + 1).toString().padStart(2, '0');
  const day = date.getDate().toString().padStart(2, '0');
  const cropCode = (cropName || 'CRP').substring(0, 3).toUpperCase().replace(/\s/g, '');
  const varCode = (varietyName || 'VAR').substring(0, 2).toUpperCase().replace(/\s/g, '');
  const random = Math.floor(Math.random() * 1000).toString().padStart(3, '0');
  let batchNumber = `RAG${cropCode}${varCode}${year}${month}${day}${random}`;
  const exists = await RamAgriBatch.findOne({ batchNumber }).select('_id').lean();
  if (exists) {
    batchNumber = `${batchNumber}_${Date.now().toString().slice(-6)}`;
  }
  return batchNumber;
}

async function resolveVariety(cropId, varietyId) {
  const crop = await RamAgriInputsProduct.findById(cropId).populate(
    'varieties.primaryUnit varieties.secondaryUnit'
  );
  if (!crop) throw new Error(`Crop not found: ${cropId}`);
  const variety = crop.varieties.id(varietyId);
  if (!variety) throw new Error(`Variety not found: ${varietyId}`);
  return { crop, variety };
}

export async function syncVarietyStockFromBatches(cropId, varietyId, userId = null) {
  const batches = await RamAgriBatch.find({
    ramAgriCropId: cropId,
    ramAgriVarietyId: varietyId,
    remainingQuantity: { $gt: 0 },
    status: { $in: ['active', 'expired'] },
  }).lean();

  const currentStock = batches.reduce((sum, b) => sum + (b.remainingQuantity || 0), 0);
  const stockValue = batches.reduce(
    (sum, b) => sum + (b.remainingQuantity || 0) * (b.purchasePrice || 0),
    0
  );
  const averagePrice = currentStock > 0 ? stockValue / currentStock : 0;

  const update = {
    'varieties.$.currentStock': currentStock,
    'varieties.$.stockValue': Number(stockValue.toFixed(2)),
    'varieties.$.averagePrice': Number(averagePrice.toFixed(4)),
    'varieties.$.stockUpdatedAt': new Date(),
  };
  if (userId) update.updatedBy = userId;

  await RamAgriInputsProduct.findOneAndUpdate(
    { _id: cropId, 'varieties._id': varietyId },
    { $set: update },
    { runValidators: false }
  );

  return { currentStock, stockValue, averagePrice };
}

export async function createInboundBatch({
  cropId,
  varietyId,
  quantityPrimary,
  batchNumber,
  expiryDate,
  manufactureDate,
  purchasePrice,
  unitId,
  supplier,
  source = 'GRN',
  referenceType,
  referenceId,
  referenceNumber,
  grnId,
  purchaseOrderId,
  receivedDate,
  userId,
  cropName,
  varietyName,
}) {
  const qty = Number(quantityPrimary) || 0;
  if (qty <= 0) throw new Error('Inbound quantity must be positive');

  const { crop, variety } = await resolveVariety(cropId, varietyId);
  const primaryUnitId =
    unitId ||
    variety.primaryUnit?._id ||
    variety.primaryUnit;

  let finalBatchNumber = batchNumber?.trim();
  if (!finalBatchNumber) {
    finalBatchNumber = await generateRamAgriBatchNumber(
      cropName || crop.cropName,
      varietyName || variety.name,
      cropId
    );
  } else {
    const dup = await RamAgriBatch.findOne({ batchNumber: finalBatchNumber }).select('_id').lean();
    if (dup) {
      finalBatchNumber = `${finalBatchNumber}_${Date.now().toString().slice(-6)}`;
    }
  }

  let parsedExpiry = expiryDate;
  if (parsedExpiry && typeof parsedExpiry === 'string') {
    parsedExpiry = new Date(parsedExpiry);
    if (Number.isNaN(parsedExpiry.getTime())) parsedExpiry = undefined;
  }
  let parsedMfg = manufactureDate;
  if (parsedMfg && typeof parsedMfg === 'string') {
    parsedMfg = new Date(parsedMfg);
    if (Number.isNaN(parsedMfg.getTime())) parsedMfg = undefined;
  }

  const batch = await RamAgriBatch.create({
    batchNumber: finalBatchNumber,
    ramAgriCropId: cropId,
    ramAgriVarietyId: varietyId,
    quantity: qty,
    remainingQuantity: qty,
    purchasePrice: Number(purchasePrice) || 0,
    unit: primaryUnitId,
    supplier: supplier || undefined,
    source,
    referenceType,
    referenceId,
    referenceNumber,
    grn: grnId,
    purchaseOrder: purchaseOrderId,
    expiryDate: parsedExpiry,
    manufactureDate: parsedMfg,
    receivedDate: receivedDate || new Date(),
    createdBy: userId,
  });

  await syncVarietyStockFromBatches(cropId, varietyId, userId);
  return batch;
}

export async function deductStockFIFO(cropId, varietyId, qtyPrimary, meta = {}) {
  const qty = Number(qtyPrimary) || 0;
  if (qty <= 0) return { ok: true, allocations: [] };

  const batches = await RamAgriBatch.find({
    ramAgriCropId: cropId,
    ramAgriVarietyId: varietyId,
    status: 'active',
    remainingQuantity: { $gt: 0 },
  })
    .sort({ receivedDate: 1, createdAt: 1 })
    .exec();

  const totalAvailable = batches.reduce((s, b) => s + b.remainingQuantity, 0);
  if (totalAvailable < qty) {
    return {
      ok: false,
      error: `Insufficient batch stock. Available: ${totalAvailable}, Required: ${qty}`,
      available: totalAvailable,
    };
  }

  let remaining = qty;
  const allocations = [];

  for (const batch of batches) {
    if (remaining <= 0) break;
    const deduct = Math.min(batch.remainingQuantity, remaining);
    batch.remainingQuantity -= deduct;
    if (batch.remainingQuantity <= 0) batch.status = 'exhausted';
    await batch.save();
    allocations.push({
      batchId: batch._id,
      batchNumber: batch.batchNumber,
      quantityDeducted: deduct,
      quantityReturned: 0,
    });
    remaining -= deduct;
  }

  await syncVarietyStockFromBatches(cropId, varietyId, meta.userId);
  return { ok: true, allocations };
}

/**
 * Restore returned qty into the same batches (LIFO reverse of dispatch allocations).
 * Mutates allocations in place (quantityReturned).
 */
export async function returnToSourceBatches(allocations, returnQtyPrimary, meta = {}) {
  const returnQty = Number(returnQtyPrimary) || 0;
  if (returnQty <= 0) return { ok: true, restored: [], legacyReturn: false };

  const list = Array.isArray(allocations) ? allocations : [];
  const maxReturnable = list.reduce(
    (s, a) => s + Math.max(0, (Number(a.quantityDeducted) || 0) - (Number(a.quantityReturned) || 0)),
    0
  );

  if (list.length === 0) {
    return createLegacyReturnBatch(meta, returnQty);
  }

  if (returnQty > maxReturnable) {
    return {
      ok: false,
      error: `Return quantity (${returnQty}) exceeds remaining allocated qty (${maxReturnable})`,
    };
  }

  let remaining = returnQty;
  const restored = [];
  const reversed = [...list].reverse();

  for (const alloc of reversed) {
    if (remaining <= 0) break;
    const deducted = Number(alloc.quantityDeducted) || 0;
    const alreadyReturned = Number(alloc.quantityReturned) || 0;
    const canRestore = deducted - alreadyReturned;
    if (canRestore <= 0) continue;

    const restoreQty = Math.min(canRestore, remaining);
    const batch = await RamAgriBatch.findById(alloc.batchId);
    if (!batch) {
      return { ok: false, error: `Batch not found: ${alloc.batchId}` };
    }
    if (batch.status === 'blocked') {
      return { ok: false, error: `Batch ${batch.batchNumber} is blocked` };
    }

    batch.remainingQuantity += restoreQty;
    if (batch.remainingQuantity > 0 && batch.status === 'exhausted') {
      batch.status = 'active';
    }
    await batch.save();

    alloc.quantityReturned = alreadyReturned + restoreQty;
    restored.push({
      batchId: batch._id,
      batchNumber: batch.batchNumber,
      quantity: restoreQty,
    });
    remaining -= restoreQty;
  }

  if (meta.cropId && meta.varietyId) {
    await syncVarietyStockFromBatches(meta.cropId, meta.varietyId, meta.userId);
  }

  return { ok: true, restored, legacyReturn: false };
}

async function createLegacyReturnBatch(meta, returnQty) {
  const { cropId, varietyId, userId, orderNumber, reason } = meta;
  if (!cropId || !varietyId || !userId) {
    return { ok: false, error: 'Missing batch allocations and crop/variety for legacy return' };
  }

  const { crop, variety } = await resolveVariety(cropId, varietyId);
  const batchNumber = await generateRamAgriBatchNumber(crop.cropName, variety.name, cropId);
  const price = Number(variety.averagePrice || variety.purchasePrice || variety.defaultRate) || 0;

  await RamAgriBatch.create({
    batchNumber,
    ramAgriCropId: cropId,
    ramAgriVarietyId: varietyId,
    quantity: returnQty,
    remainingQuantity: returnQty,
    purchasePrice: price,
    unit: variety.primaryUnit?._id || variety.primaryUnit,
    source: 'SALES_RETURN',
    referenceType: 'AgriSalesOrder',
    referenceId: meta.orderId,
    referenceNumber: orderNumber,
    notes: `Legacy return (no dispatch allocations). ${reason || ''}`.trim(),
    receivedDate: new Date(),
    createdBy: userId,
  });

  await syncVarietyStockFromBatches(cropId, varietyId, userId);
  return {
    ok: true,
    restored: [{ batchNumber, quantity: returnQty, legacy: true }],
    legacyReturn: true,
  };
}

export async function applyManualStockAdjustment(cropId, varietyId, newStock, userId) {
  const parsedStock = Number(newStock);
  if (!Number.isFinite(parsedStock) || parsedStock < 0) {
    throw new Error('currentStock must be a non-negative number');
  }

  const { crop, variety } = await resolveVariety(cropId, varietyId);
  const oldStock = Number(variety.currentStock) || 0;
  const delta = parsedStock - oldStock;

  if (delta === 0) {
    return { currentStock: oldStock, delta: 0 };
  }

  if (delta > 0) {
    const price =
      Number(variety.averagePrice || variety.purchasePrice || variety.defaultRate) || 0;
    await createInboundBatch({
      cropId,
      varietyId,
      quantityPrimary: delta,
      purchasePrice: price,
      unitId: variety.primaryUnit?._id || variety.primaryUnit,
      source: 'MANUAL_ADJUSTMENT',
      referenceType: 'ManualAdjustment',
      userId,
      cropName: crop.cropName,
      varietyName: variety.name,
    });
  } else {
    const result = await deductStockFIFO(cropId, varietyId, Math.abs(delta), { userId });
    if (!result.ok) throw new Error(result.error);
  }

  const synced = await syncVarietyStockFromBatches(cropId, varietyId, userId);
  return { ...synced, delta };
}

export async function processRamAgriGrnItem(item, grn, userId) {
  if (!item.isRamAgriProduct || !item.ramAgriCropId || !item.ramAgriVarietyId) {
    return null;
  }

  const crop = await RamAgriInputsProduct.findById(item.ramAgriCropId).populate(
    'varieties.primaryUnit varieties.secondaryUnit'
  );
  if (!crop) return null;
  const variety = crop.varieties.id(item.ramAgriVarietyId);
  if (!variety) return null;

  const quantityPrimary = toPrimaryUnitQuantity(item, variety);
  let batchNumber = item.batchNumber || item.lotNumber;
  if (batchNumber) batchNumber = batchNumber.trim();

  const batch = await createInboundBatch({
    cropId: item.ramAgriCropId,
    varietyId: item.ramAgriVarietyId,
    quantityPrimary,
    batchNumber: batchNumber || undefined,
    expiryDate: item.expiryDate,
    manufactureDate: item.manufactureDate,
    purchasePrice: item.rate,
    unitId: variety.primaryUnit?._id || variety.primaryUnit,
    supplier: grn.supplier,
    source: 'GRN',
    referenceType: 'GRN',
    referenceId: grn._id,
    referenceNumber: grn.grnNumber,
    grnId: grn._id,
    purchaseOrderId: grn.purchaseOrder,
    receivedDate: grn.grnDate,
    userId,
    cropName: item.ramAgriCropName || crop.cropName,
    varietyName: item.ramAgriVarietyName || variety.name,
  });

  return batch;
}

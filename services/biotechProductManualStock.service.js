import mongoose from 'mongoose';
import Product from '../models/product.model.js';
import Batch from '../models/batch.model.js';
import InventoryTransaction from '../models/inventoryTransaction.model.js';
import { sortBatchesByExpiry } from './batchExpiryOrder.js';
import { buildAgriLinkByProductIdMap } from './biotechSeedMaster.service.js';
import { applyManualStockAdjustment } from './ramAgriBatchInventory.service.js';

async function generateProductBatchNumber(product) {
  const code = String(product.code || product.name || 'SEED')
    .replace(/\s+/g, '')
    .slice(0, 8)
    .toUpperCase();
  const stamp = Date.now().toString(36).toUpperCase();
  let batchNumber = `MADJ-${code}-${stamp}`;
  const exists = await Batch.findOne({ batchNumber }).select('_id').lean();
  if (exists) batchNumber = `${batchNumber}-${Math.floor(Math.random() * 9999)}`;
  return batchNumber;
}

async function deductProductStockFifo(productId, qty, userId) {
  const need = Math.max(0, Number(qty) || 0);
  if (need < 0.001) return { ok: true, deducted: 0 };

  const batches = await Batch.find({
    product: productId,
    status: { $in: ['active', 'expired'] },
    remainingQuantity: { $gt: 0 },
  }).lean();

  sortBatchesByExpiry(batches, 'fifo');

  let left = need;
  for (const b of batches) {
    if (left <= 0) break;
    const doc = await Batch.findById(b._id);
    if (!doc) continue;
    const avail = Number(doc.remainingQuantity) || 0;
    if (avail <= 0) continue;
    const take = Math.min(avail, left);
    doc.remainingQuantity = Math.max(0, avail - take);
    if (doc.remainingQuantity <= 0) doc.status = 'exhausted';
    await doc.save();
    left -= take;
  }

  if (left > 0.001) {
    return { ok: false, error: `Insufficient batch stock (short by ${left})` };
  }

  const product = await Product.findById(productId);
  if (!product) return { ok: false, error: 'Product not found' };

  const before = Number(product.currentStock) || 0;
  if (before < need) {
    return { ok: false, error: 'Insufficient product stock' };
  }
  product.currentStock = Math.max(0, before - need);
  product.stockUpdatedAt = new Date();
  if (userId) product.updatedBy = userId;
  await product.save({ validateBeforeSave: false });

  const txnNumber = await InventoryTransaction.generateTransactionNumber();
  await InventoryTransaction.create({
    transactionNumber: txnNumber,
    transactionDate: new Date(),
    transactionType: 'adjustment',
    product: productId,
    quantity: need,
    unit: product.primaryUnit,
    balanceBeforeTransaction: before,
    balanceAfterTransaction: product.currentStock,
    referenceType: 'Adjustment',
    reason: 'Manual stock decrease',
    performedBy: userId,
    metadata: { manualAdjustment: true, direction: 'out' },
  });

  return { ok: true, deducted: need, currentStock: product.currentStock };
}

async function addProductStock(productId, qty, userId, { batchNumber, expiryDate } = {}) {
  const addQty = Math.max(0, Number(qty) || 0);
  if (addQty < 0.001) return { ok: true, added: 0 };

  const product = await Product.findById(productId);
  if (!product) return { ok: false, error: 'Product not found' };
  if (!product.primaryUnit) {
    return { ok: false, error: 'Product has no primary unit configured' };
  }

  let finalBatchNumber = String(batchNumber || '').trim();
  if (!finalBatchNumber) finalBatchNumber = await generateProductBatchNumber(product);

  let parsedExpiry;
  if (expiryDate) {
    parsedExpiry = expiryDate instanceof Date ? expiryDate : new Date(expiryDate);
    if (Number.isNaN(parsedExpiry.getTime())) parsedExpiry = undefined;
  }

  const purchasePrice = Number(product.averagePrice || product.costPrice) || 0;
  const before = Number(product.currentStock) || 0;

  const batch = await Batch.create({
    batchNumber: finalBatchNumber,
    product: productId,
    expiryDate: parsedExpiry,
    receivedDate: new Date(),
    purchasePrice,
    quantity: addQty,
    remainingQuantity: addQty,
    unit: product.primaryUnit,
    status: 'active',
    notes: 'Manual stock adjustment',
  });

  product.currentStock = before + addQty;
  product.stockValue = (Number(product.stockValue) || 0) + addQty * purchasePrice;
  product.averagePrice =
    product.currentStock > 0 ? product.stockValue / product.currentStock : purchasePrice;
  product.stockUpdatedAt = new Date();
  if (userId) product.updatedBy = userId;
  await product.save({ validateBeforeSave: false });

  const txnNumber = await InventoryTransaction.generateTransactionNumber();
  await InventoryTransaction.create({
    transactionNumber: txnNumber,
    transactionDate: new Date(),
    transactionType: 'adjustment',
    product: productId,
    batch: batch._id,
    quantity: addQty,
    unit: product.primaryUnit,
    balanceBeforeTransaction: before,
    balanceAfterTransaction: product.currentStock,
    rate: purchasePrice,
    value: addQty * purchasePrice,
    referenceType: 'Adjustment',
    reason: 'Manual stock increase',
    performedBy: userId,
    metadata: { manualAdjustment: true, direction: 'in', batchNumber: finalBatchNumber },
  });

  return { ok: true, added: addQty, currentStock: product.currentStock, batchId: batch._id };
}

/**
 * Adjust Biotech seed product stock by signed delta.
 * If product is linked to Ram Agri variety, adjust Agri lots (keeps Product in sync).
 */
export async function applyBiotechProductManualStock(
  productId,
  quantityDelta,
  userId,
  options = {}
) {
  if (!mongoose.isValidObjectId(productId)) {
    throw new Error('Invalid product ID');
  }
  const delta = Number(quantityDelta);
  if (!Number.isFinite(delta) || delta === 0) {
    throw new Error('quantityDelta must be a non-zero number');
  }

  const linkMap = await buildAgriLinkByProductIdMap();
  const agri = linkMap.get(String(productId));
  if (agri?.cropId && agri?.varietyId) {
    const product = await Product.findById(productId).select('currentStock').lean();
    const oldStock = Number(product?.currentStock) || Number(agri.agriStock) || 0;
    const newStock = Math.max(0, oldStock + delta);
    const batches =
      delta > 0
        ? [
            {
              batchNumber: options.batchNumber,
              expiryDate: options.expiryDate,
              quantity: delta,
            },
          ]
        : [];
    return applyManualStockAdjustment(
      agri.cropId,
      agri.varietyId,
      newStock,
      userId,
      { batches }
    );
  }

  if (delta > 0) {
    const result = await addProductStock(productId, delta, userId, options);
    if (!result.ok) throw new Error(result.error || 'Stock increase failed');
    return { currentStock: result.currentStock, delta };
  }

  const result = await deductProductStockFifo(productId, Math.abs(delta), userId);
  if (!result.ok) throw new Error(result.error || 'Stock decrease failed');
  return { currentStock: result.currentStock, delta };
}

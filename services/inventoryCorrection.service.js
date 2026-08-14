/**
 * Immutable inventory: never update/delete — post a correction/reversal txn.
 */
import InventoryTransaction from "../../models/inventoryTransaction.model.js";
import Batch from "../../models/batch.model.js";
import Product from "../../models/product.model.js";

/**
 * Post a correction that undoes a classic inventory transaction and restores stock.
 * Original row stays untouched.
 */
export async function postInventoryCorrection({
  originalTxnId,
  reason = "",
  userId,
  applyStock = true,
} = {}) {
  if (!originalTxnId) return { ok: false, error: "originalTxnId required", status: 400 };

  const original = await InventoryTransaction.findById(originalTxnId).lean();
  if (!original) return { ok: false, error: "Inventory transaction not found", status: 404 };

  const existing = await InventoryTransaction.exists({ reversalOf: original._id });
  if (existing) return { ok: true, skipped: true, reason: "already_reversed" };

  const qty = Number(original.quantity) || 0;
  if (qty <= 0) return { ok: false, error: "Original qty invalid", status: 400 };

  // Purchase return was type "return" (stock out). Correction restores = inward.
  const wasOut =
    original.transactionType === "return" || original.transactionType === "outward";
  const correctionType = wasOut ? "inward" : "outward";

  let balanceBefore = 0;
  let balanceAfter = 0;
  const product = await Product.findById(original.product);
  if (!product) return { ok: false, error: "Product not found", status: 404 };

  balanceBefore = Number(product.currentStock) || 0;

  if (applyStock) {
    if (wasOut) {
      // restore stock that was taken by return/outward
      if (original.batch) {
        const batch = await Batch.findById(original.batch);
        if (batch) {
          batch.remainingQuantity = (Number(batch.remainingQuantity) || 0) + qty;
          if (batch.status === "exhausted" && batch.remainingQuantity > 0) {
            batch.status = "available";
          }
          await batch.save();
        }
      }
      product.currentStock = balanceBefore + qty;
      const amt = Number(original.value) || qty * (Number(original.rate) || 0);
      product.stockValue = (Number(product.stockValue) || 0) + amt;
      product.averagePrice =
        product.currentStock > 0 ? product.stockValue / product.currentStock : 0;
      product.updatedBy = userId;
      await product.save();
      balanceAfter = product.currentStock;
    } else {
      // undo an inward → take stock out again
      if ((Number(product.currentStock) || 0) < qty) {
        return { ok: false, error: "Insufficient stock to reverse inward", status: 400 };
      }
      if (original.batch) {
        const batch = await Batch.findById(original.batch);
        if (batch) {
          if ((Number(batch.remainingQuantity) || 0) < qty) {
            return { ok: false, error: "Insufficient batch qty to reverse", status: 400 };
          }
          batch.remainingQuantity = Math.max(0, (Number(batch.remainingQuantity) || 0) - qty);
          if (batch.remainingQuantity <= 0) batch.status = "exhausted";
          await batch.save();
        }
      }
      const amt = Number(original.value) || qty * (Number(original.rate) || 0);
      product.currentStock = Math.max(0, balanceBefore - qty);
      product.stockValue = Math.max(0, (Number(product.stockValue) || 0) - amt);
      product.averagePrice =
        product.currentStock > 0 ? product.stockValue / product.currentStock : 0;
      product.updatedBy = userId;
      await product.save();
      balanceAfter = product.currentStock;
    }
  } else {
    balanceAfter = balanceBefore;
  }

  const txnNumber = await InventoryTransaction.generateTransactionNumber();
  const txn = await InventoryTransaction.create({
    transactionNumber: txnNumber,
    transactionDate: new Date(),
    transactionType: correctionType === "inward" ? "adjustment" : "adjustment",
    product: original.product,
    batch: original.batch,
    quantity: qty,
    unit: original.unit,
    balanceBeforeTransaction: balanceBefore,
    balanceAfterTransaction: balanceAfter,
    rate: original.rate,
    value: original.value,
    referenceType: original.referenceType || "Adjustment",
    referenceId: original.referenceId,
    referenceNumber: original.referenceNumber || "",
    reason: reason || `Correction of ${original.transactionNumber}`,
    remarks: `Reversal/correction of ${original.transactionNumber}`,
    performedBy: userId,
    reversalOf: original._id,
    metadata: {
      correctionOf: original._id,
      originalType: original.transactionType,
      stockDirection: wasOut ? "restore" : "remove",
    },
  });

  return { ok: true, data: txn, created: true };
}

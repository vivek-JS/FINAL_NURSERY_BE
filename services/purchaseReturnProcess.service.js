/**
 * Purchase return create/process — stock mutate + money ledger post.
 * Kept separate so purchaseReturn.service.js stays under 700 lines.
 */
import mongoose from "mongoose";
import PurchaseOrder from "../models/purchaseOrder.model.js";
import Batch from "../models/batch.model.js";
import Product from "../models/product.model.js";
import InventoryTransaction from "../models/inventoryTransaction.model.js";
import PurchaseReturn from "../models/purchaseReturn.model.js";

async function maybeUpdateSlot(slotId, qty, productName) {
  if (!slotId || !(qty > 0)) return;
  try {
    const { default: PlantSlot } = await import("../models/slots.model.js");
    const slot = await PlantSlot.findById(slotId);
    if (!slot) return;
    if (typeof slot.availablePlants === "number") {
      slot.availablePlants = Math.max(0, (slot.availablePlants || 0) - qty);
    }
    if (Array.isArray(slot.productStock) && productName) {
      const row = slot.productStock.find(
        (p) => String(p.productName || "").toLowerCase() === String(productName).toLowerCase()
      );
      if (row && typeof row.quantity === "number") {
        row.quantity = Math.max(0, row.quantity - qty);
      }
    }
    await slot.save();
  } catch (e) {
    console.warn("[purchaseReturn] slot update skipped:", e?.message);
  }
}

/**
 * Create immediate purchase return (office) for classic batches.
 * body: { supplierId } OR { purchaseOrderId }, plus batchReturns[]
 */
export async function processPurchaseReturn({
  purchaseOrderId,
  supplierId,
  batchReturns,
  returnReason = "",
  returnNotes = "",
  userId,
}) {
  if (!Array.isArray(batchReturns) || !batchReturns.length) {
    return { ok: false, error: "At least one batch return is required", status: 400 };
  }

  const {
    getPurchaseReturnableBatches,
    getSupplierReturnableBatches,
  } = await import("./purchaseReturn.service.js");

  const isSupplierMode = Boolean(supplierId);
  let avail;
  let primaryPoId = purchaseOrderId;
  let source = "PO_WISE";

  if (isSupplierMode) {
    if (!mongoose.isValidObjectId(supplierId)) {
      return { ok: false, error: "Valid supplierId is required", status: 400 };
    }
    avail = await getSupplierReturnableBatches(supplierId);
    source = "SUPPLIER_BATCH";
  } else {
    if (!mongoose.isValidObjectId(purchaseOrderId)) {
      return { ok: false, error: "Valid purchaseOrderId is required", status: 400 };
    }
    avail = await getPurchaseReturnableBatches(purchaseOrderId);
  }
  if (!avail.ok) return avail;

  const byBatch = new Map((avail.data.batches || []).map((b) => [String(b.batchId), b]));

  const wantMap = new Map();
  for (const br of batchReturns) {
    const id = String(br.batchId || "");
    const q = Number(br.returnQuantity) || 0;
    if (!id || q <= 0) continue;
    wantMap.set(id, (wantMap.get(id) || 0) + q);
  }
  if (!wantMap.size) {
    return { ok: false, error: "Enter return quantity for at least one batch", status: 400 };
  }

  // Validate ALL lines against snapshot before any stock mutation
  for (const [batchId, qty] of wantMap.entries()) {
    const meta = byBatch.get(batchId);
    if (!meta) {
      return {
        ok: false,
        error: `Batch ${batchId} is not returnable for this ${isSupplierMode ? "supplier" : "PO"}`,
        status: 400,
      };
    }
    if (qty > meta.maxReturnQuantity + 1e-9) {
      return {
        ok: false,
        error: `Return qty ${qty} exceeds available ${meta.maxReturnQuantity} for batch ${meta.batchNumber}`,
        status: 400,
      };
    }
    if (!(meta.purchaseOrderId || primaryPoId)) {
      return {
        ok: false,
        error: `No purchase order linked for batch ${meta.batchNumber}`,
        status: 400,
      };
    }
  }

  const returnNumber = await PurchaseReturn.generateReturnNumber();
  const lines = [];
  let totalQuantity = 0;
  let totalAmount = 0;
  const poTotals = new Map(); // poId -> { purchaseOrder, poNumber, returnQuantity, returnAmount }

  for (const [batchId, qty] of wantMap.entries()) {
    const meta = byBatch.get(batchId);
    const linePoId = meta.purchaseOrderId || primaryPoId;
    if (!primaryPoId) primaryPoId = linePoId;

    // Ram Agri batch return
    if (meta.isRamAgriProduct || meta.inventoryKind === "RAM_AGRI") {
      const { applyAgriPurchaseReturnLine } = await import("./purchaseReturnAgri.helpers.js");
      const agri = await applyAgriPurchaseReturnLine({
        meta: { ...meta, purchaseOrderId: linePoId },
        qty,
        returnNumber,
        returnReason,
        returnNotes,
        userId,
      });
      if (!agri.ok) return agri;

      const poKey = String(linePoId);
      if (!poTotals.has(poKey)) {
        poTotals.set(poKey, {
          purchaseOrder: linePoId,
          poNumber: agri.poNumber || meta.poNumber || "",
          returnQuantity: 0,
          returnAmount: 0,
        });
      }
      const pt = poTotals.get(poKey);
      pt.returnQuantity += qty;
      pt.returnAmount += agri.amount;
      if (!pt.poNumber && agri.poNumber) pt.poNumber = agri.poNumber;

      lines.push({ ...agri.line, poNumber: pt.poNumber });
      totalQuantity += qty;
      totalAmount += agri.amount;
      continue;
    }

    const batch = await Batch.findById(batchId);
    if (!batch) return { ok: false, error: `Batch not found: ${batchId}`, status: 404 };
    if ((Number(batch.remainingQuantity) || 0) < qty) {
      return {
        ok: false,
        error: `Insufficient remaining qty on batch ${batch.batchNumber}`,
        status: 400,
      };
    }

    const product = await Product.findById(batch.product);
    if (!product) return { ok: false, error: "Product not found for batch", status: 404 };

    const oldStock = Number(product.currentStock) || 0;
    const rate = Number(meta.rate) || Number(batch.purchasePrice) || 0;
    const amount = qty * rate;

    batch.remainingQuantity = Math.max(0, (Number(batch.remainingQuantity) || 0) - qty);
    if (batch.remainingQuantity <= 0) batch.status = "exhausted";
    await batch.save();

    product.currentStock = Math.max(0, oldStock - qty);
    product.stockValue = Math.max(0, (Number(product.stockValue) || 0) - amount);
    product.averagePrice =
      product.currentStock > 0 ? product.stockValue / product.currentStock : 0;
    product.updatedBy = userId;
    await product.save();

    const txnNumber = await InventoryTransaction.generateTransactionNumber();
    await InventoryTransaction.create({
      transactionNumber: txnNumber,
      transactionDate: new Date(),
      transactionType: "return",
      product: product._id,
      batch: batch._id,
      quantity: qty,
      unit: batch.unit || meta.unitId,
      balanceBeforeTransaction: oldStock,
      balanceAfterTransaction: product.currentStock,
      rate,
      value: amount,
      referenceType: "PurchaseReturn",
      // referenceId set after PurchaseReturn.create — do NOT updateMany (immutable)
      referenceNumber: returnNumber,
      reason: returnReason || "Purchase return to supplier",
      remarks: returnNotes || "",
      performedBy: userId,
      metadata: { deferredReferenceLink: true },
    });

    await maybeUpdateSlot(meta.slotId, qty, meta.productName);

    const po = await PurchaseOrder.findById(linePoId);
    if (po?.items?.length) {
      const poItem = po.items.find(
        (it) => !it.isRamAgriProduct && String(it.product) === String(product._id)
      );
      if (poItem) {
        poItem.receivedQuantity = Math.max(0, (Number(poItem.receivedQuantity) || 0) - qty);
        po.markModified("items");
        const anyReceived = po.items.some((it) => (Number(it.receivedQuantity) || 0) > 0);
        if (!anyReceived && ["received", "partial_received", "RECEIVED"].includes(String(po.status))) {
          po.status = "approved";
        } else if (anyReceived) {
          const allFull = po.items.every(
            (it) => (Number(it.receivedQuantity) || 0) >= (Number(it.quantity) || 0)
          );
          if (!allFull && String(po.status).toLowerCase() === "received") {
            po.status = "partial_received";
          }
        }
        await po.save();
      }
    }

    const poKey = String(linePoId);
    if (!poTotals.has(poKey)) {
      poTotals.set(poKey, {
        purchaseOrder: linePoId,
        poNumber: meta.poNumber || po?.poNumber || "",
        returnQuantity: 0,
        returnAmount: 0,
      });
    }
    const pt = poTotals.get(poKey);
    pt.returnQuantity += qty;
    pt.returnAmount += amount;
    if (!pt.poNumber && po?.poNumber) pt.poNumber = po.poNumber;

    lines.push({
      product: product._id,
      productName: meta.productName,
      batch: batch._id,
      batchNumber: batch.batchNumber,
      grn: meta.grnId,
      grnNumber: meta.grnNumber,
      purchaseOrder: linePoId,
      poNumber: pt.poNumber,
      unit: batch.unit || meta.unitId,
      returnQuantity: qty,
      rate,
      amount,
      expiryDate: meta.expiryDate,
      slotId: meta.slotId,
    });
    totalQuantity += qty;
    totalAmount += amount;
  }

  // Prefer primary PO = largest return qty for supplier-batch docs
  let primaryPoNumber = "";
  if (isSupplierMode && poTotals.size) {
    const ranked = [...poTotals.values()].sort((a, b) => b.returnQuantity - a.returnQuantity);
    primaryPoId = ranked[0].purchaseOrder;
    primaryPoNumber = ranked[0].poNumber;
  } else {
    primaryPoNumber = avail.data.purchaseOrder?.poNumber || "";
  }

  const supplierRef = isSupplierMode
    ? supplierId
    : avail.data.purchaseOrder?.supplier?._id || avail.data.purchaseOrder?.supplier;

  const doc = await PurchaseReturn.create({
    returnNumber,
    purchaseOrder: primaryPoId,
    poNumber: primaryPoNumber,
    source,
    affectedPurchaseOrders: [...poTotals.values()],
    supplier: supplierRef,
    status: "COMPLETED",
    lines,
    totalQuantity,
    totalAmount,
    returnReason: returnReason?.trim() || "",
    returnNotes: returnNotes?.trim() || "",
    createdBy: userId,
    ledgerStatus: "PENDING",
  });

  // Link inventory txns via NEW correction-safe create path is N/A —
  // we only set referenceId on create. Skip updateMany (immutable).
  // Match by referenceNumber for history; stamp via insert of metadata-only is forbidden.
  // Create lightweight link records? No — referenceNumber is enough.

  let ledgerStatus = "PENDING";
  let ledgerError = "";
  let ledgerResult = null;
  try {
    const { postPurchaseReturnAp } = await import("./moneyLedger/index.js");
    ledgerResult = await postPurchaseReturnAp(doc, userId);
    if (ledgerResult?.skipped) {
      ledgerStatus = "SKIPPED";
    } else if (ledgerResult?.ok) {
      const failed = (ledgerResult.results || []).some((r) => r && r.ok === false);
      ledgerStatus = failed ? "FAILED" : "POSTED";
      if (failed) {
        ledgerError = (ledgerResult.results || [])
          .filter((r) => r && !r.ok)
          .map((r) => r.error)
          .join("; ");
      }
    } else {
      ledgerStatus = "FAILED";
      ledgerError = ledgerResult?.error || "AP ledger post failed";
    }
  } catch (ledgerErr) {
    ledgerStatus = "FAILED";
    ledgerError = ledgerErr?.message || String(ledgerErr);
    console.error("[purchaseReturn] AP ledger post failed:", ledgerError);
  }

  doc.ledgerStatus = ledgerStatus;
  doc.ledgerError = ledgerError;
  await doc.save();

  return {
    ok: true,
    data: doc,
    ledgerStatus,
    ledgerError: ledgerError || undefined,
    warning:
      ledgerStatus === "FAILED"
        ? `Stock returned but money ledger failed: ${ledgerError}. Run money-ledger backfill / repost.`
        : undefined,
  };
}


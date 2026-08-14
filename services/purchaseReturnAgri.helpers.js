/**
 * Ram Agri slice of purchase returns (GRN → RamAgriBatch).
 * Kept separate so purchaseReturn.service.js stays under 700 lines.
 */
import mongoose from "mongoose";
import GRN from "../models/grn.model.js";
import PurchaseOrder from "../models/purchaseOrder.model.js";
import RamAgriBatch from "../models/ramAgriBatch.model.js";
import { syncVarietyStockFromBatches } from "./ramAgriBatchInventory.service.js";

function toId(v) {
  if (!v) return null;
  if (typeof v === "object" && v._id) return String(v._id);
  return String(v);
}

/** Aggregate Ram Agri returnable qty by GRN.supplier AND batch.supplier. */
export async function aggregateAgriReturnableBySupplier() {
  const fromGrn = await GRN.aggregate([
    { $match: { status: { $in: ["approved", "APPROVED"] }, supplier: { $ne: null } } },
    { $unwind: "$items" },
    {
      $match: {
        "items.isRamAgriProduct": true,
        "items.ramAgriBatch": { $ne: null },
      },
    },
    {
      $lookup: {
        from: "ramagribatches",
        localField: "items.ramAgriBatch",
        foreignField: "_id",
        as: "rb",
      },
    },
    { $unwind: "$rb" },
    { $match: { "rb.remainingQuantity": { $gt: 0 } } },
    {
      $group: {
        _id: "$supplier",
        returnableQty: { $sum: "$rb.remainingQuantity" },
        returnableBatchCount: { $addToSet: "$rb._id" },
      },
    },
    {
      $project: {
        returnableQty: 1,
        returnableBatchCount: { $size: "$returnableBatchCount" },
      },
    },
  ]);

  const fromBatch = await RamAgriBatch.aggregate([
    {
      $match: {
        supplier: { $ne: null },
        remainingQuantity: { $gt: 0 },
        status: { $in: ["active", "expired"] },
      },
    },
    {
      $group: {
        _id: "$supplier",
        returnableQty: { $sum: "$remainingQuantity" },
        returnableBatchCount: { $sum: 1 },
      },
    },
  ]);

  const map = new Map();
  for (const row of [...fromGrn, ...fromBatch]) {
    const key = String(row._id);
    if (!map.has(key)) {
      map.set(key, { _id: row._id, returnableQty: 0, returnableBatchCount: 0 });
    }
    const cur = map.get(key);
    cur.returnableQty += Number(row.returnableQty) || 0;
    // fromGrn uses unique batch count; fromBatch uses sum — prefer max to avoid double-count blowup
    cur.returnableBatchCount = Math.max(
      Number(cur.returnableBatchCount) || 0,
      Number(row.returnableBatchCount) || 0
    );
  }
  return [...map.values()];
}

/** Returnable Ram Agri batches for a party (merchant/supplier on GRN). */
export async function getAgriSupplierReturnableBatches(supplierId) {
  if (!mongoose.isValidObjectId(supplierId)) return [];

  const grns = await GRN.find({
    supplier: supplierId,
    status: { $in: ["approved", "APPROVED"] },
  })
    .select("grnNumber purchaseOrder items")
    .lean();

  const batches = [];
  const seen = new Set();

  for (const grn of grns) {
    let po = null;
    if (grn.purchaseOrder) {
      po = await PurchaseOrder.findById(grn.purchaseOrder).select("poNumber").lean();
    }
    for (const item of grn.items || []) {
      if (!item.isRamAgriProduct || !item.ramAgriBatch) continue;
      const bid = String(item.ramAgriBatch);
      if (seen.has(bid)) continue;
      const rab = await RamAgriBatch.findById(item.ramAgriBatch).lean();
      if (!rab) continue;
      const maxReturnQuantity = Math.max(0, Number(rab.remainingQuantity) || 0);
      if (maxReturnQuantity <= 0) continue;
      seen.add(bid);

      const productName =
        [item.ramAgriCropName, item.ramAgriVarietyName].filter(Boolean).join(" · ") ||
        "Ram Agri product";

      batches.push({
        batchId: bid,
        batchNumber: rab.batchNumber || item.batchNumber || "—",
        productId: toId(item.ramAgriCropId || rab.ramAgriCropId),
        productName,
        productCode: "",
        ramAgriCropId: toId(item.ramAgriCropId || rab.ramAgriCropId),
        ramAgriVarietyId: toId(item.ramAgriVarietyId || rab.ramAgriVarietyId),
        unitId: toId(rab.unit || item.unit),
        unitName: "",
        expiryDate: rab.expiryDate || item.expiryDate || null,
        rate: Number(item.rate ?? rab.purchasePrice) || 0,
        acceptedQuantity: Number(item.acceptedQuantity) || Number(rab.quantity) || 0,
        availableQuantity: maxReturnQuantity,
        maxReturnQuantity,
        grnId: String(grn._id),
        grnNumber: grn.grnNumber,
        purchaseOrderId: po?._id ? String(po._id) : grn.purchaseOrder ? String(grn.purchaseOrder) : null,
        poNumber: po?.poNumber || "",
        isRamAgriProduct: true,
        inventoryKind: "RAM_AGRI",
      });
    }
  }

  // Batches tagged with supplier but missing GRN item link
  const tagged = await RamAgriBatch.find({
    supplier: supplierId,
    remainingQuantity: { $gt: 0 },
    status: { $in: ["active", "expired"] },
    _id: { $nin: [...seen].filter((id) => mongoose.isValidObjectId(id)) },
  }).lean();

  for (const rab of tagged) {
    if (seen.has(String(rab._id))) continue;
    const maxReturnQuantity = Math.max(0, Number(rab.remainingQuantity) || 0);
    if (maxReturnQuantity <= 0) continue;
    batches.push({
      batchId: String(rab._id),
      batchNumber: rab.batchNumber,
      productId: toId(rab.ramAgriCropId),
      productName: "Ram Agri product",
      productCode: "",
      ramAgriCropId: toId(rab.ramAgriCropId),
      ramAgriVarietyId: toId(rab.ramAgriVarietyId),
      unitId: toId(rab.unit),
      unitName: "",
      expiryDate: rab.expiryDate || null,
      rate: Number(rab.purchasePrice) || 0,
      acceptedQuantity: Number(rab.quantity) || 0,
      availableQuantity: maxReturnQuantity,
      maxReturnQuantity,
      grnId: rab.grn ? String(rab.grn) : null,
      grnNumber: rab.referenceNumber || "",
      purchaseOrderId: rab.purchaseOrder ? String(rab.purchaseOrder) : null,
      poNumber: "",
      isRamAgriProduct: true,
      inventoryKind: "RAM_AGRI",
    });
  }

  return batches;
}

/**
 * Deduct Ram Agri batch + sync variety stock for purchase return.
 * @returns line payload fields for PurchaseReturn.lines
 */
export async function applyAgriPurchaseReturnLine({ meta, qty, returnNumber, returnReason, returnNotes, userId }) {
  const rab = await RamAgriBatch.findById(meta.batchId);
  if (!rab) {
    return { ok: false, error: `Ram Agri batch not found: ${meta.batchNumber || meta.batchId}`, status: 404 };
  }
  if ((Number(rab.remainingQuantity) || 0) < qty) {
    return {
      ok: false,
      error: `Insufficient remaining qty on batch ${rab.batchNumber}`,
      status: 400,
    };
  }

  const rate = Number(meta.rate) || Number(rab.purchasePrice) || 0;
  const amount = qty * rate;

  rab.remainingQuantity = Math.max(0, (Number(rab.remainingQuantity) || 0) - qty);
  if (rab.remainingQuantity <= 0) rab.status = "exhausted";
  await rab.save();

  const cropId = meta.ramAgriCropId || rab.ramAgriCropId;
  const varietyId = meta.ramAgriVarietyId || rab.ramAgriVarietyId;
  if (cropId && varietyId) {
    await syncVarietyStockFromBatches(cropId, varietyId, userId);
    const { safeAppendRamAgriStockMovements, RAM_AGRI_MOVEMENT_TYPES } = await import(
      "./ramAgriStockMovement.service.js"
    );
    await safeAppendRamAgriStockMovements({
      cropId,
      varietyId,
      movementType: RAM_AGRI_MOVEMENT_TYPES.PURCHASE_RETURN_OUT,
      batchRows: [
        {
          batchId: rab._id,
          batchNumber: rab.batchNumber,
          quantity: qty,
        },
      ],
      referenceType: "PurchaseReturn",
      referenceNumber: returnNumber || "",
      description:
        returnReason ||
        `Purchase return ${returnNumber || ""}`.trim() ||
        "Purchase return to supplier",
      performedBy: userId,
      metadata: {
        source: "PURCHASE_RETURN",
        returnNotes: returnNotes || "",
        rate,
        amount,
      },
    });
  }

  // Adjust PO received qty for matching agri line
  if (meta.purchaseOrderId) {
    const po = await PurchaseOrder.findById(meta.purchaseOrderId);
    if (po?.items?.length) {
      const poItem = po.items.find(
        (it) =>
          it.isRamAgriProduct &&
          String(it.ramAgriCropId) === String(cropId) &&
          String(it.ramAgriVarietyId) === String(varietyId)
      );
      if (poItem) {
        poItem.receivedQuantity = Math.max(0, (Number(poItem.receivedQuantity) || 0) - qty);
        po.markModified("items");
        await po.save();
      }
    }
  }

  return {
    ok: true,
    line: {
      product: null,
      productName: meta.productName,
      batch: rab._id,
      batchNumber: rab.batchNumber,
      grn: meta.grnId,
      grnNumber: meta.grnNumber,
      purchaseOrder: meta.purchaseOrderId,
      poNumber: meta.poNumber || "",
      unit: rab.unit || meta.unitId,
      returnQuantity: qty,
      rate,
      amount,
      expiryDate: meta.expiryDate || rab.expiryDate,
      isRamAgriProduct: true,
      ramAgriCropId: cropId,
      ramAgriVarietyId: varietyId,
    },
    amount,
    poId: meta.purchaseOrderId,
    poNumber: meta.poNumber || "",
    metaNote: `${returnReason || "Purchase return"} ${returnNotes || ""} ${returnNumber}`.trim(),
  };
}

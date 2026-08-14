/**
 * Biotech / classic inventory purchase return (supplier return) — reverse GRN batch stock.
 */
import mongoose from "mongoose";
import PurchaseOrder from "../models/purchaseOrder.model.js";
import GRN from "../models/grn.model.js";
import Batch from "../models/batch.model.js";
import PurchaseReturn from "../models/purchaseReturn.model.js";

function toId(v) {
  if (!v) return null;
  if (typeof v === "object" && v._id) return String(v._id);
  return String(v);
}

/** Eligible classic batches still on hand for a purchase order. */
export async function getPurchaseReturnableBatches(purchaseOrderId) {
  if (!mongoose.isValidObjectId(purchaseOrderId)) {
    return { ok: false, error: "Valid purchaseOrderId is required", status: 400 };
  }

  const po = await PurchaseOrder.findById(purchaseOrderId)
    .populate("supplier", "name phoneNumber contactPerson")
    .lean();
  if (!po) return { ok: false, error: "Purchase order not found", status: 404 };

  const grns = await GRN.find({
    purchaseOrder: purchaseOrderId,
    status: "approved",
  })
    .select("grnNumber grnDate items status")
    .lean();

  const batches = [];
  for (const grn of grns) {
    for (const item of grn.items || []) {
      if (item.isRamAgriProduct) continue; // biotech / classic only
      const batchId = item.batch;
      if (!batchId) continue;
      const batch = await Batch.findById(batchId)
        .populate("product", "name code currentStock")
        .populate("unit", "name abbreviation")
        .lean();
      if (!batch) continue;
      const maxReturnQuantity = Math.max(0, Number(batch.remainingQuantity) || 0);
      if (maxReturnQuantity <= 0) continue;

      batches.push({
        batchId: String(batch._id),
        batchNumber: batch.batchNumber,
        productId: toId(batch.product),
        productName: batch.product?.name || item.productName || "Product",
        productCode: batch.product?.code || "",
        unitId: toId(batch.unit || item.unit),
        unitName: batch.unit?.abbreviation || batch.unit?.name || "",
        expiryDate: batch.expiryDate || item.expiryDate || null,
        rate: Number(item.rate ?? batch.purchasePrice) || 0,
        acceptedQuantity: Number(item.acceptedQuantity) || 0,
        maxReturnQuantity,
        availableQuantity: maxReturnQuantity,
        grnId: String(grn._id),
        grnNumber: grn.grnNumber,
        purchaseOrderId: String(po._id),
        poNumber: po.poNumber,
        slotId: item.slotId || null,
      });
    }
  }

  batches.sort((a, b) => {
    const ae = a.expiryDate ? new Date(a.expiryDate).getTime() : Number.MAX_SAFE_INTEGER;
    const be = b.expiryDate ? new Date(b.expiryDate).getTime() : Number.MAX_SAFE_INTEGER;
    if (ae !== be) return ae - be;
    return String(a.batchNumber).localeCompare(String(b.batchNumber));
  });

  return {
    ok: true,
    data: {
      purchaseOrder: {
        _id: po._id,
        poNumber: po.poNumber,
        status: po.status,
        supplier: po.supplier,
      },
      batches,
    },
  };
}

function isClassicGrnItem(item) {
  return item && !item.isRamAgriProduct && item.batch;
}

async function resolvePurchaseParty(partyId) {
  if (!partyId || !mongoose.isValidObjectId(partyId)) return null;
  const Supplier = (await import("../models/supplier.model.js")).default;
  const Merchant = (await import("../models/merchant.model.js")).default;
  const asSupplier = await Supplier.findById(partyId)
    .select("name phone phoneNumber contactPerson code")
    .lean();
  if (asSupplier) {
    return {
      _id: asSupplier._id,
      name: asSupplier.name,
      phoneNumber: asSupplier.phoneNumber || asSupplier.phone || "",
      contactPerson: asSupplier.contactPerson || "",
      partyType: "SUPPLIER",
    };
  }
  const asMerchant = await Merchant.findById(partyId)
    .select("name phone contactPerson code")
    .lean();
  if (asMerchant) {
    return {
      _id: asMerchant._id,
      name: asMerchant.name,
      phoneNumber: asMerchant.phone || "",
      contactPerson: asMerchant.contactPerson || "",
      partyType: "MERCHANT",
    };
  }
  return {
    _id: partyId,
    name: `Party ${String(partyId).slice(-6)}`,
    phoneNumber: "",
    contactPerson: "",
    partyType: "UNKNOWN",
  };
}

/** Eligible classic batches still on hand for a supplier/merchant (via GRN.supplier). */
export async function getSupplierReturnableBatches(supplierId) {
  if (!mongoose.isValidObjectId(supplierId)) {
    return { ok: false, error: "Valid supplierId is required", status: 400 };
  }

  const party = await resolvePurchaseParty(supplierId);
  if (!party) return { ok: false, error: "Supplier not found", status: 404 };

  const grns = await GRN.find({
    supplier: supplierId,
    status: { $in: ["approved", "APPROVED"] },
  })
    .select("grnNumber grnDate purchaseOrder items status")
    .lean();

  const batches = [];
  const seen = new Set();

  for (const grn of grns) {
    for (const item of grn.items || []) {
      if (!isClassicGrnItem(item)) continue;
      const batchId = item.batch;
      if (!batchId || seen.has(String(batchId))) continue;
      try {
        await import("../models/measurementUnit.model.js");
      } catch {
        /* optional */
      }
      const batch = await Batch.findById(batchId)
        .populate("product", "name code currentStock")
        .populate({ path: "unit", select: "name abbreviation", options: { strictPopulate: false } })
        .lean();
      if (!batch) continue;
      const maxReturnQuantity = Math.max(0, Number(batch.remainingQuantity) || 0);
      if (maxReturnQuantity <= 0) continue;
      seen.add(String(batchId));

      let po = null;
      if (grn.purchaseOrder) {
        po = await PurchaseOrder.findById(grn.purchaseOrder)
          .select("poNumber status supplier")
          .lean();
      }

      batches.push({
        batchId: String(batch._id),
        batchNumber: batch.batchNumber,
        productId: toId(batch.product),
        productName: batch.product?.name || item.productName || "Product",
        productCode: batch.product?.code || "",
        unitId: toId(batch.unit || item.unit),
        unitName: batch.unit?.abbreviation || batch.unit?.name || "",
        expiryDate: batch.expiryDate || item.expiryDate || null,
        rate: Number(item.rate ?? batch.purchasePrice) || 0,
        acceptedQuantity: Number(item.acceptedQuantity) || Number(batch.quantity) || 0,
        availableQuantity: maxReturnQuantity,
        maxReturnQuantity,
        grnId: String(grn._id),
        grnNumber: grn.grnNumber,
        purchaseOrderId: po?._id ? String(po._id) : grn.purchaseOrder ? String(grn.purchaseOrder) : null,
        poNumber: po?.poNumber || "",
        slotId: item.slotId || null,
        isRamAgriProduct: false,
        inventoryKind: "CLASSIC",
      });
    }
  }

  // Fallback: batches tagged with supplier id but missing from GRN walk
  const tagged = await Batch.find({
    supplier: supplierId,
    remainingQuantity: { $gt: 0 },
    status: { $in: ["active", "expired"] },
    _id: { $nin: [...seen].map((id) => new mongoose.Types.ObjectId(id)) },
  })
    .populate("product", "name code currentStock")
    .populate({ path: "unit", select: "name abbreviation", options: { strictPopulate: false } })
    .lean();

  for (const batch of tagged) {
    const grn = batch.grn
      ? await GRN.findById(batch.grn).select("grnNumber purchaseOrder items status").lean()
      : null;
    if (grn && String(grn.status).toLowerCase() !== "approved") continue;
    const grnItem = (grn?.items || []).find((it) => String(it.batch) === String(batch._id));
    if (grnItem && !isClassicGrnItem(grnItem)) continue;

    let po = null;
    if (grn?.purchaseOrder) {
      po = await PurchaseOrder.findById(grn.purchaseOrder).select("poNumber status").lean();
    }
    const maxReturnQuantity = Math.max(0, Number(batch.remainingQuantity) || 0);
    if (maxReturnQuantity <= 0) continue;

    batches.push({
      batchId: String(batch._id),
      batchNumber: batch.batchNumber,
      productId: toId(batch.product),
      productName: batch.product?.name || grnItem?.productName || "Product",
      productCode: batch.product?.code || "",
      unitId: toId(batch.unit || grnItem?.unit),
      unitName: batch.unit?.abbreviation || batch.unit?.name || "",
      expiryDate: batch.expiryDate || grnItem?.expiryDate || null,
      rate: Number(grnItem?.rate ?? batch.purchasePrice) || 0,
      acceptedQuantity: Number(grnItem?.acceptedQuantity) || Number(batch.quantity) || 0,
      availableQuantity: maxReturnQuantity,
      maxReturnQuantity,
      grnId: grn?._id ? String(grn._id) : null,
      grnNumber: grn?.grnNumber || "",
      purchaseOrderId: po?._id ? String(po._id) : grn?.purchaseOrder ? String(grn.purchaseOrder) : null,
      poNumber: po?.poNumber || "",
      slotId: grnItem?.slotId || null,
      isRamAgriProduct: false,
      inventoryKind: "CLASSIC",
    });
  }

  // Ram Agri batches purchased from this party
  const {
    getAgriSupplierReturnableBatches,
  } = await import("./purchaseReturnAgri.helpers.js");
  const agriBatches = await getAgriSupplierReturnableBatches(supplierId);
  batches.push(...agriBatches);

  batches.sort((a, b) => {
    const ae = a.expiryDate ? new Date(a.expiryDate).getTime() : Number.MAX_SAFE_INTEGER;
    const be = b.expiryDate ? new Date(b.expiryDate).getTime() : Number.MAX_SAFE_INTEGER;
    if (ae !== be) return ae - be;
    return String(a.batchNumber).localeCompare(String(b.batchNumber));
  });

  return {
    ok: true,
    data: {
      supplier: {
        _id: party._id,
        name: party.name,
        phoneNumber: party.phoneNumber,
        partyType: party.partyType,
      },
      batches,
    },
  };
}

/** Parties (Supplier or Merchant on GRN) with classic OR Ram Agri returnable stock. */
export async function listEligibleSuppliersForReturn({ search = "", limit = 80 } = {}) {
  const lim = Math.min(150, Math.max(1, Number(limit) || 80));

  const classicAgg = await GRN.aggregate([
    { $match: { status: { $in: ["approved", "APPROVED"] }, supplier: { $ne: null } } },
    { $unwind: "$items" },
    {
      $match: {
        "items.isRamAgriProduct": { $ne: true },
        "items.batch": { $ne: null },
      },
    },
    {
      $lookup: {
        from: "batches",
        localField: "items.batch",
        foreignField: "_id",
        as: "batchDoc",
      },
    },
    { $unwind: "$batchDoc" },
    { $match: { "batchDoc.remainingQuantity": { $gt: 0 } } },
    {
      $group: {
        _id: "$supplier",
        returnableQty: { $sum: "$batchDoc.remainingQuantity" },
        returnableBatchCount: { $addToSet: "$batchDoc._id" },
      },
    },
    {
      $project: {
        returnableQty: 1,
        returnableBatchCount: { $size: "$returnableBatchCount" },
      },
    },
  ]);

  const { aggregateAgriReturnableBySupplier } = await import("./purchaseReturnAgri.helpers.js");
  const agriAgg = await aggregateAgriReturnableBySupplier();

  const byParty = new Map();
  for (const row of [...classicAgg, ...agriAgg]) {
    const key = String(row._id);
    if (!byParty.has(key)) {
      byParty.set(key, { _id: row._id, returnableQty: 0, returnableBatchCount: 0 });
    }
    const cur = byParty.get(key);
    cur.returnableQty += Number(row.returnableQty) || 0;
    cur.returnableBatchCount += Number(row.returnableBatchCount) || 0;
  }

  if (!byParty.size) return { ok: true, data: [] };

  const q = String(search || "").trim().toLowerCase();
  const eligible = [];
  for (const row of byParty.values()) {
    const party = await resolvePurchaseParty(row._id);
    if (!party) continue;
    if (q) {
      const hay = `${party.name} ${party.phoneNumber} ${party.contactPerson}`.toLowerCase();
      if (!hay.includes(q)) continue;
    }
    eligible.push({
      _id: party._id,
      name: party.name,
      phoneNumber: party.phoneNumber,
      contactPerson: party.contactPerson,
      partyType: party.partyType,
      returnableQty: row.returnableQty,
      returnableBatchCount: row.returnableBatchCount,
    });
  }

  eligible.sort((a, b) => b.returnableQty - a.returnableQty);
  return { ok: true, data: eligible.slice(0, lim) };
}

/** POs that still have returnable classic batch stock. */
export async function listEligiblePurchaseOrdersForReturn({ search = "", limit = 50 } = {}) {
  const lim = Math.min(100, Math.max(1, Number(limit) || 50));
  const approvedGrns = await GRN.find({ status: "approved" })
    .select("purchaseOrder items")
    .limit(500)
    .lean();

  const poIds = new Set();
  for (const grn of approvedGrns) {
    const hasClassic = (grn.items || []).some(
      (it) => !it.isRamAgriProduct && it.batch && Number(it.acceptedQuantity) > 0
    );
    if (hasClassic && grn.purchaseOrder) poIds.add(String(grn.purchaseOrder));
  }

  if (!poIds.size) return { ok: true, data: [] };

  const filter = {
    _id: { $in: [...poIds].map((id) => new mongoose.Types.ObjectId(id)) },
    status: { $in: ["approved", "partial_received", "received", "APPROVED", "RECEIVED"] },
  };
  const q = String(search || "").trim();
  if (q) {
    filter.$or = [
      { poNumber: { $regex: q, $options: "i" } },
      { invoiceNumber: { $regex: q, $options: "i" } },
    ];
  }

  const pos = await PurchaseOrder.find(filter)
    .populate("supplier", "name phoneNumber")
    .sort({ createdAt: -1 })
    .limit(lim)
    .select("poNumber status supplier poDate totalAmount items")
    .lean();

  // Keep only POs that still have remaining batch qty
  const eligible = [];
  for (const po of pos) {
    const ret = await getPurchaseReturnableBatches(po._id);
    const maxQty = (ret.data?.batches || []).reduce((s, b) => s + Number(b.maxReturnQuantity || 0), 0);
    if (maxQty <= 0) continue;
    eligible.push({
      _id: po._id,
      poNumber: po.poNumber,
      status: po.status,
      supplier: po.supplier,
      poDate: po.poDate,
      totalAmount: po.totalAmount,
      returnableQty: maxQty,
      returnableBatchCount: ret.data?.batches?.length || 0,
    });
  }

  return { ok: true, data: eligible };
}

export { processPurchaseReturn } from "./purchaseReturnProcess.service.js";

export async function listPurchaseReturns({
  status = "ALL",
  search = "",
  dateFrom,
  dateTo,
  page = 1,
  limit = 25,
} = {}) {
  const filter = {};
  if (status && status !== "ALL") filter.status = String(status).toUpperCase();
  const q = String(search || "").trim();
  if (q) {
    filter.$or = [
      { returnNumber: { $regex: q, $options: "i" } },
      { poNumber: { $regex: q, $options: "i" } },
      { returnReason: { $regex: q, $options: "i" } },
    ];
  }
  if (dateFrom || dateTo) {
    filter.returnedAt = {};
    if (dateFrom) {
      const from = new Date(dateFrom);
      if (!Number.isNaN(from.getTime())) filter.returnedAt.$gte = from;
    }
    if (dateTo) {
      const to = new Date(dateTo);
      if (!Number.isNaN(to.getTime())) {
        to.setHours(23, 59, 59, 999);
        filter.returnedAt.$lte = to;
      }
    }
    if (!Object.keys(filter.returnedAt).length) delete filter.returnedAt;
  }

  const lim = Math.min(100, Math.max(1, parseInt(limit, 10) || 25));
  const pg = Math.max(1, parseInt(page, 10) || 1);
  const skip = (pg - 1) * lim;

  const [data, total] = await Promise.all([
    PurchaseReturn.find(filter)
      .populate("supplier", "name phoneNumber")
      .populate("createdBy", "name")
      .populate("purchaseOrder", "poNumber status totalAmount")
      .sort({ returnedAt: -1 })
      .skip(skip)
      .limit(lim)
      .lean(),
    PurchaseReturn.countDocuments(filter),
  ]);

  return {
    ok: true,
    data: {
      data,
      pagination: { total, page: pg, limit: lim, pages: Math.ceil(total / lim) || 1 },
    },
  };
}

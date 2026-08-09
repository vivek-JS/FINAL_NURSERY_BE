/**
 * Merchant-aggregated Ram Agri batch sale return (office, immediate).
 * Silent FIFO allocation across the merchant's dispatched orders for each batch.
 */
import mongoose from "mongoose";
import AgriSalesOrder, {
  getAgriOrderLines,
  computeAgriReturnCreditAmount,
} from "../models/agriSalesOrder.model.js";
import AgriSalesReturnRequest from "../models/agriSalesReturnRequest.model.js";
import RamAgriBatch from "../models/ramAgriBatch.model.js";
import Merchant from "../models/merchant.model.js";
import { returnToExplicitBatches } from "./ramAgriBatchInventory.service.js";
import { createCustomerLedgerEntry } from "../utils/ramAgriLedgerHelper.js";

export const OFFICE_RETURN_ROLES = new Set([
  "SUPER_ADMIN",
  "ADMIN",
  "OFFICE_ADMIN",
  "RAM_AGRI_SALES_MANAGER",
  "RAM_AGRI_SALES_OFFICE_MANAGER",
  "RAM_AGRI_MASTER",
]);

export function isOfficeReturnUser(user) {
  const jt = String(user?.jobTitle || "").toUpperCase().trim();
  const r = String(user?.role || "").toUpperCase().trim();
  return OFFICE_RETURN_ROLES.has(jt) || OFFICE_RETURN_ROLES.has(r);
}

function getLineBatchAllocations(order, lineIndex) {
  if (Array.isArray(order.lineItems) && order.lineItems.length > lineIndex) {
    return order.lineItems[lineIndex].batchAllocations || [];
  }
  if (lineIndex === 0 && Array.isArray(order.batchAllocations)) {
    return order.batchAllocations;
  }
  return [];
}

function setLineBatchAllocations(order, lineIndex, allocations) {
  if (order.lineItems?.[lineIndex]) {
    order.lineItems[lineIndex].batchAllocations = allocations;
    order.markModified("lineItems");
  } else if (lineIndex === 0) {
    order.batchAllocations = allocations;
    order.markModified("batchAllocations");
  }
}

function productLabelForLine(line) {
  if (line?.ramAgriCropName || line?.ramAgriVarietyName) {
    return [line.ramAgriCropName, line.ramAgriVarietyName].filter(Boolean).join(" · ");
  }
  return line?.productName || "Product";
}

function isDispatchEligible(order) {
  const status = String(order.orderStatus || "").toUpperCase();
  const dispatch = String(order.dispatchStatus || "").toUpperCase();
  if (status === "CANCELLED") return false;
  if (status === "DISPATCHED" || status === "COMPLETED") return true;
  return ["DISPATCHED", "IN_TRANSIT", "DELIVERED"].includes(dispatch);
}

/** Collect returnable allocation slices for a merchant, oldest first. */
export async function collectMerchantReturnSlices(merchantId) {
  const orders = await AgriSalesOrder.find({
    merchant: merchantId,
    $or: [
      { orderStatus: { $in: ["DISPATCHED", "COMPLETED"] } },
      { dispatchStatus: { $in: ["DISPATCHED", "IN_TRANSIT", "DELIVERED"] } },
    ],
  }).sort({ dispatchedAt: 1, createdAt: 1 });

  const slices = [];
  for (const order of orders) {
    if (!isDispatchEligible(order)) continue;
    const lines = getAgriOrderLines(order);
    for (let li = 0; li < lines.length; li++) {
      const line = lines[li];
      const allocations = getLineBatchAllocations(order, li);
      for (const alloc of allocations) {
        const deducted = Number(alloc.quantityDeducted) || 0;
        const returned = Number(alloc.quantityReturned) || 0;
        const maxReturnQuantity = Math.max(0, deducted - returned);
        if (maxReturnQuantity <= 0 || !alloc.batchId) continue;
        slices.push({
          order,
          lineIndex: li,
          line,
          lineItemId: order.lineItems?.[li]?._id,
          alloc,
          batchId: String(alloc.batchId),
          batchNumber: alloc.batchNumber || "",
          maxReturnQuantity,
          productName: productLabelForLine(line),
          ramAgriCropId: line.ramAgriCropId,
          ramAgriVarietyId: line.ramAgriVarietyId,
          dispatchedAt: order.dispatchedAt || order.createdAt,
        });
      }
    }
  }
  return slices;
}

/** Aggregate by batchId for GET UI (no order picker). */
export async function getMerchantReturnableBatches(merchantId) {
  if (!mongoose.isValidObjectId(merchantId)) {
    return { ok: false, error: "Valid merchantId is required", status: 400 };
  }
  const merchant = await Merchant.findById(merchantId).select("name phone").lean();
  if (!merchant) {
    return { ok: false, error: "Merchant not found", status: 404 };
  }

  const slices = await collectMerchantReturnSlices(merchantId);
  const byBatch = new Map();
  for (const s of slices) {
    const key = s.batchId;
    if (!byBatch.has(key)) {
      byBatch.set(key, {
        batchId: s.batchId,
        batchNumber: s.batchNumber,
        productName: s.productName,
        ramAgriCropId: s.ramAgriCropId,
        ramAgriVarietyId: s.ramAgriVarietyId,
        soldQty: 0,
        alreadyReturned: 0,
        maxReturnQuantity: 0,
        orderCount: 0,
        orderIds: new Set(),
      });
    }
    const row = byBatch.get(key);
    const deducted = Number(s.alloc.quantityDeducted) || 0;
    const returned = Number(s.alloc.quantityReturned) || 0;
    row.soldQty += deducted;
    row.alreadyReturned += returned;
    row.maxReturnQuantity += s.maxReturnQuantity;
    row.orderIds.add(String(s.order._id));
    if (!row.batchNumber && s.batchNumber) row.batchNumber = s.batchNumber;
  }

  const batchIds = [...byBatch.keys()];
  const batchDocs = batchIds.length
    ? await RamAgriBatch.find({ _id: { $in: batchIds } }).select("batchNumber expiryDate").lean()
    : [];
  const expiryMap = Object.fromEntries(
    batchDocs.map((b) => [String(b._id), { expiryDate: b.expiryDate, batchNumber: b.batchNumber }])
  );

  const batches = [...byBatch.values()]
    .map((row) => {
      const meta = expiryMap[row.batchId] || {};
      return {
        batchId: row.batchId,
        batchNumber: row.batchNumber || meta.batchNumber || "—",
        expiryDate: meta.expiryDate || null,
        productName: row.productName,
        ramAgriCropId: row.ramAgriCropId,
        ramAgriVarietyId: row.ramAgriVarietyId,
        soldQty: row.soldQty,
        alreadyReturned: row.alreadyReturned,
        maxReturnQuantity: row.maxReturnQuantity,
        orderCount: row.orderIds.size,
      };
    })
    .filter((b) => b.maxReturnQuantity > 0)
    .sort((a, b) => {
      const ae = a.expiryDate ? new Date(a.expiryDate).getTime() : Number.MAX_SAFE_INTEGER;
      const be = b.expiryDate ? new Date(b.expiryDate).getTime() : Number.MAX_SAFE_INTEGER;
      if (ae !== be) return ae - be;
      return String(a.batchNumber).localeCompare(String(b.batchNumber));
    });

  return {
    ok: true,
    data: {
      merchant: { _id: merchant._id, name: merchant.name, phone: merchant.phone },
      batches,
    },
  };
}

async function adjustMerchantMoney(merchantId, creditAmount) {
  if (!merchantId || !(creditAmount > 0)) return;
  await Merchant.findByIdAndUpdate(merchantId, {
    $inc: {
      totalOrderValue: -creditAmount,
      outstandingAmount: -creditAmount,
    },
  });
}

/**
 * Apply office merchant-batch return immediately (stock + ledger + merchant money).
 * body: { merchantId, batchReturns: [{ batchId, returnQuantity }], returnReason, returnNotes }
 */
export async function processMerchantBatchReturn({
  merchantId,
  batchReturns,
  returnReason = "",
  returnNotes = "",
  userId,
}) {
  if (!mongoose.isValidObjectId(merchantId)) {
    return { ok: false, error: "Valid merchantId is required", status: 400 };
  }
  if (!Array.isArray(batchReturns) || batchReturns.length === 0) {
    return { ok: false, error: "At least one batch return is required", status: 400 };
  }

  const merchant = await Merchant.findById(merchantId).select("_id name");
  if (!merchant) {
    return { ok: false, error: "Merchant not found", status: 404 };
  }

  const wantMap = new Map();
  for (const br of batchReturns) {
    const batchId = String(br.batchId || "");
    const returnQuantity = Number(br.returnQuantity) || 0;
    if (!batchId || returnQuantity <= 0) continue;
    wantMap.set(batchId, (wantMap.get(batchId) || 0) + returnQuantity);
  }
  const wanted = [...wantMap.entries()].map(([batchId, returnQuantity]) => ({
    batchId,
    returnQuantity,
  }));

  if (!wanted.length) {
    return { ok: false, error: "Enter return quantity for at least one batch", status: 400 };
  }

  const slices = await collectMerchantReturnSlices(merchantId);
  const byBatch = new Map();
  for (const s of slices) {
    if (!byBatch.has(s.batchId)) byBatch.set(s.batchId, []);
    byBatch.get(s.batchId).push(s);
  }

  /** @type {Map<string, { order, lineReturns: object[], credit: number, qty: number }>} */
  const perOrderWork = new Map();
  let totalCredit = 0;
  let totalQty = 0;
  const appliedBatches = [];

  for (const want of wanted) {
    const batchSlices = byBatch.get(want.batchId) || [];
    const available = batchSlices.reduce((s, x) => s + x.maxReturnQuantity, 0);
    if (want.returnQuantity > available + 1e-9) {
      return {
        ok: false,
        error: `Return qty ${want.returnQuantity} exceeds max ${available} for batch`,
        status: 400,
      };
    }

    let remaining = want.returnQuantity;
    const batchNumber = batchSlices[0]?.batchNumber || "";

    for (const slice of batchSlices) {
      if (remaining <= 0) break;
      const take = Math.min(remaining, slice.maxReturnQuantity);
      if (take <= 0) continue;

      const orderId = String(slice.order._id);
      if (!perOrderWork.has(orderId)) {
        perOrderWork.set(orderId, {
          order: slice.order,
          lineBuckets: new Map(),
          credit: 0,
          qty: 0,
        });
      }
      const work = perOrderWork.get(orderId);
      const lineKey = String(slice.lineIndex);
      if (!work.lineBuckets.has(lineKey)) {
        work.lineBuckets.set(lineKey, {
          lineIndex: slice.lineIndex,
          line: slice.line,
          lineItemId: slice.lineItemId,
          ramAgriVarietyId: slice.ramAgriVarietyId,
          productName: slice.productName,
          returnQuantity: 0,
          batchReturns: [],
          allocations: getLineBatchAllocations(slice.order, slice.lineIndex).map((a) => ({
            batchId: a.batchId,
            batchNumber: a.batchNumber,
            quantityDeducted: Number(a.quantityDeducted) || 0,
            quantityReturned: Number(a.quantityReturned) || 0,
          })),
        });
      }
      const bucket = work.lineBuckets.get(lineKey);
      bucket.returnQuantity += take;
      bucket.batchReturns.push({
        batchId: slice.batchId,
        batchNumber: slice.batchNumber || batchNumber,
        quantity: take,
      });
      work.qty += take;
      remaining -= take;
    }

    if (remaining > 1e-6) {
      return {
        ok: false,
        error: `Could not fully allocate return for batch ${batchNumber || want.batchId}`,
        status: 400,
      };
    }
    appliedBatches.push({
      batchId: want.batchId,
      batchNumber,
      returnQuantity: want.returnQuantity,
    });
  }

  const auditRequests = [];
  const updatedOrders = [];

  for (const work of perOrderWork.values()) {
    const order = work.order;
    let orderCredit = 0;
    let orderQty = 0;
    const auditLineReturns = [];

    for (const bucket of work.lineBuckets.values()) {
      const { lineIndex, line, returnQuantity, batchReturns, allocations } = bucket;
      if (returnQuantity <= 0) continue;

      const result = await returnToExplicitBatches(allocations, batchReturns, {
        cropId: line.ramAgriCropId,
        varietyId: line.ramAgriVarietyId,
        orderId: order._id,
        orderNumber: order.orderNumber,
        userId,
        reason: returnReason || "Merchant batch sale return",
        movementType: "DEALER_RETURN_IN",
        description: `Merchant sale return — ${order.orderNumber || order._id}`,
        metadata: { merchantId: String(merchantId), source: "MERCHANT_BATCH_RETURN" },
      });
      if (!result.ok) {
        return { ok: false, error: result.error || "Stock restore failed", status: 400 };
      }

      setLineBatchAllocations(order, lineIndex, allocations);
      if (order.lineItems?.[lineIndex]) {
        order.lineItems[lineIndex].returnQuantity =
          (Number(order.lineItems[lineIndex].returnQuantity) || 0) + returnQuantity;
        order.lineItems[lineIndex].deliveredQuantity = Math.max(
          0,
          (Number(order.lineItems[lineIndex].quantity) || 0) -
            (Number(order.lineItems[lineIndex].returnQuantity) || 0)
        );
        order.markModified("lineItems");
      }

      const lineCredit = computeAgriReturnCreditAmount(line, returnQuantity);
      orderCredit += lineCredit;
      orderQty += returnQuantity;
      auditLineReturns.push({
        lineItemId: bucket.lineItemId,
        ramAgriVarietyId: bucket.ramAgriVarietyId,
        productName: bucket.productName,
        returnQuantity,
        batchReturns,
      });
    }

    const previousTotal = Number(order.totalAmount) || 0;
    order.salesReturnQuantity = (Number(order.salesReturnQuantity) || 0) + orderQty;
    order.returnQuantity = (Number(order.returnQuantity) || 0) + orderQty;
    order.deliveredQuantity = Math.max(
      0,
      (Number(order.quantity) || 0) - (Number(order.salesReturnQuantity) || 0)
    );
    order.totalAmount = Math.max(0, previousTotal - orderCredit);
    order.balanceAmount = Math.max(
      0,
      (Number(order.balanceAmount) || previousTotal - (Number(order.totalPaidAmount) || 0)) - orderCredit
    );
    if (order.balanceAmount <= 0) {
      order.paymentStatus =
        (Number(order.totalPaidAmount) || 0) >= (Number(order.totalAmount) || 0)
          ? "PAID"
          : order.paymentStatus;
    }
    await order.save();

    await adjustMerchantMoney(merchantId, orderCredit);

    const audit = await AgriSalesReturnRequest.create({
      orderId: order._id,
      orderNumber: order.orderNumber,
      dealer: order.dealer || userId,
      status: "APPROVED",
      lineReturns: auditLineReturns,
      returnReason: returnReason?.trim() || "Merchant batch sale return",
      returnNotes: returnNotes?.trim() || "",
      requestedBy: userId,
      reviewedBy: userId,
      reviewedAt: new Date(),
      reviewNotes: "Office merchant-batch return (immediate)",
      stockReturned: true,
      creditAmount: orderCredit,
    });

    const ledgerEntry = await createCustomerLedgerEntry({
      customerMobile: order.customerMobile,
      customerName: order.customerName,
      refType: "SALES_RETURN",
      refId: audit._id,
      orderId: order._id,
      credit: orderCredit,
      reference: order.orderNumber,
      category: "Sales Return",
      description: `Merchant batch sale return for order ${order.orderNumber}`,
      entryDate: new Date(),
      createdBy: userId,
      metadata: {
        returnRequestId: audit._id,
        merchantId: String(merchantId),
        source: "MERCHANT_BATCH_RETURN",
        totalReturnQty: orderQty,
      },
    });

    if (ledgerEntry?._id) {
      audit.ledgerRefId = ledgerEntry._id;
      await audit.save();
    }

    totalCredit += orderCredit;
    totalQty += orderQty;
    auditRequests.push(audit);
    updatedOrders.push({
      orderId: order._id,
      orderNumber: order.orderNumber,
      returnQuantity: orderQty,
      creditAmount: orderCredit,
    });
  }

  return {
    ok: true,
    data: {
      merchantId,
      merchantName: merchant.name,
      totalReturnQty: totalQty,
      totalCredit,
      appliedBatches,
      orders: updatedOrders,
      returnRequests: auditRequests.map((r) => r._id),
    },
  };
}

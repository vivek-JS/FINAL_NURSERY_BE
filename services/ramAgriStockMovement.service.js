import mongoose from "mongoose";
import RamAgriStockMovement, {
  RAM_AGRI_MOVEMENT_CATEGORY_LABELS,
  RAM_AGRI_MOVEMENT_TYPES,
} from "../models/ramAgriStockMovement.model.js";

const parseNum = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

export function movementTypeToDirection(movementType) {
  const outTypes = new Set([
    RAM_AGRI_MOVEMENT_TYPES.MANUAL_OUT,
    RAM_AGRI_MOVEMENT_TYPES.SALE_DISPATCH_OUT,
    RAM_AGRI_MOVEMENT_TYPES.SOWING_RAISING_OUT,
  ]);
  if (outTypes.has(movementType)) return "OUT";
  return "IN";
}

export function getMovementCategoryLabel(movementType) {
  return RAM_AGRI_MOVEMENT_CATEGORY_LABELS[movementType] || movementType;
}

function buildGroupKey({ referenceType, referenceId, movementType, performedAt }) {
  const ref = referenceId ? String(referenceId) : "none";
  const ts = performedAt ? new Date(performedAt).getTime() : Date.now();
  return `${movementType}:${referenceType || "none"}:${ref}:${ts}`;
}

/**
 * Persist one or more batch-level stock movements (non-blocking for callers).
 * @param {Object} params
 * @param {Array<{batchId,batchNumber,quantity}>} params.batchRows
 */
export async function appendRamAgriStockMovements({
  cropId,
  varietyId,
  movementType,
  batchRows = [],
  referenceType = null,
  referenceId = null,
  referenceNumber = null,
  description = null,
  performedBy = null,
  movementGroupKey = null,
  performedAt = null,
  metadata = {},
}) {
  if (!cropId || !varietyId || !movementType) return;

  const direction = movementTypeToDirection(movementType);
  const rows = (Array.isArray(batchRows) ? batchRows : []).filter(
    (r) => parseNum(r.quantity) > 0
  );
  if (rows.length === 0) return;

  const groupKey =
    movementGroupKey ||
    buildGroupKey({
      referenceType,
      referenceId,
      movementType,
      performedAt: performedAt || new Date(),
    });

  const docs = rows.map((row) => ({
    ramAgriCropId: new mongoose.Types.ObjectId(String(cropId)),
    ramAgriVarietyId: new mongoose.Types.ObjectId(String(varietyId)),
    batchId: row.batchId ? new mongoose.Types.ObjectId(String(row.batchId)) : undefined,
    batchNumber: row.batchNumber || null,
    direction,
    movementType,
    quantity: parseNum(row.quantity),
    referenceType: referenceType || undefined,
    referenceId: referenceId ? new mongoose.Types.ObjectId(String(referenceId)) : undefined,
    referenceNumber: referenceNumber || undefined,
    description: description || getMovementCategoryLabel(movementType),
    movementGroupKey: groupKey,
    performedBy: performedBy ? new mongoose.Types.ObjectId(String(performedBy)) : undefined,
    metadata,
    ...(performedAt ? { createdAt: new Date(performedAt), updatedAt: new Date(performedAt) } : {}),
  }));

  await RamAgriStockMovement.insertMany(docs, { ordered: false });
}

/** Safe wrapper — never throws to stock callers. */
export async function safeAppendRamAgriStockMovements(params) {
  try {
    await appendRamAgriStockMovements(params);
  } catch (err) {
    console.error("[RamAgriStockMovement] append failed:", err?.message || err);
  }
}

export function allocationsToBatchRows(allocations, qtyField = "quantityDeducted") {
  return (Array.isArray(allocations) ? allocations : [])
    .map((a) => ({
      batchId: a.batchId,
      batchNumber: a.batchNumber,
      quantity: parseNum(a[qtyField] ?? a.quantity),
    }))
    .filter((r) => r.quantity > 0);
}

export function restoredToBatchRows(restored) {
  return (Array.isArray(restored) ? restored : [])
    .map((r) => ({
      batchId: r.batchId,
      batchNumber: r.batchNumber,
      quantity: parseNum(r.quantity),
    }))
    .filter((r) => r.quantity > 0);
}

export { RAM_AGRI_MOVEMENT_TYPES, RAM_AGRI_MOVEMENT_CATEGORY_LABELS };

/**
 * Build variety ledger entries from persisted movements (grouped by movementGroupKey).
 */
export async function buildVarietyLedgerFromMovements({
  cropId,
  varietyId,
  currentStock = 0,
  startDate = null,
  endDate = null,
}) {
  const query = {
    ramAgriCropId: new mongoose.Types.ObjectId(String(cropId)),
    ramAgriVarietyId: new mongoose.Types.ObjectId(String(varietyId)),
  };

  if (startDate || endDate) {
    query.createdAt = {};
    if (startDate) query.createdAt.$gte = new Date(startDate);
    if (endDate) query.createdAt.$lte = new Date(`${endDate}T23:59:59.999Z`);
  }

  const movements = await RamAgriStockMovement.find(query)
    .sort({ createdAt: 1, _id: 1 })
    .lean();

  if (!movements.length) return null;

  const groupMap = new Map();
  for (const row of movements) {
    const key = row.movementGroupKey || String(row._id);
    if (!groupMap.has(key)) groupMap.set(key, []);
    groupMap.get(key).push(row);
  }

  const ledgerEntries = [];
  for (const rows of groupMap.values()) {
    const first = rows[0];
    const quantity = rows.reduce((s, r) => s + parseNum(r.quantity), 0);
    if (quantity <= 0) continue;

    const type = first.direction === "OUT" ? "DEBIT" : "CREDIT";
    ledgerEntries.push({
      date: first.createdAt,
      type,
      category: getMovementCategoryLabel(first.movementType),
      movementType: first.movementType,
      reference: first.referenceNumber || (first.referenceId ? String(first.referenceId) : "—"),
      description: first.description || getMovementCategoryLabel(first.movementType),
      quantity,
      unit: null,
      rate: 0,
      amount: 0,
      balance: 0,
      batches: rows.map((r) => ({
        batchId: r.batchId,
        batchNumber: r.batchNumber,
        quantity: parseNum(r.quantity),
      })),
      details: {
        referenceType: first.referenceType,
        referenceId: first.referenceId,
        movementGroupKey: first.movementGroupKey,
        metadata: first.metadata,
      },
    });
  }

  ledgerEntries.sort((a, b) => new Date(a.date) - new Date(b.date));

  const totalCredit = ledgerEntries
    .filter((e) => e.type === "CREDIT")
    .reduce((sum, e) => sum + (e.quantity || 0), 0);
  const totalDebit = ledgerEntries
    .filter((e) => e.type === "DEBIT")
    .reduce((sum, e) => sum + (e.quantity || 0), 0);
  const openingStock = parseNum(currentStock) - totalCredit + totalDebit;

  let runningBalance = openingStock;
  const entriesWithBalance = ledgerEntries
    .map((entry) => {
      if (entry.type === "CREDIT") runningBalance += entry.quantity;
      else runningBalance -= entry.quantity;
      return { ...entry, balance: runningBalance };
    })
    .reverse();

  return {
    summary: {
      openingStock,
      totalCredit,
      totalDebit,
      closingStock: parseNum(currentStock),
    },
    entries: entriesWithBalance,
    source: "movements",
  };
}

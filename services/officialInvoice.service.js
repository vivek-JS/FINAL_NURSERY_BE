import InvoiceSequence, {
  INV_BILLABLE_SEQUENCE_KEY,
  INV_NON_BILLABLE_SEQUENCE_KEY,
} from "../models/invoiceSequence.model.js";
import { resolveOrderDcBillableBuckets } from "./officialDeliveryChallan.service.js";

/** @deprecated Plant-scoped keys — use globalInvoiceSequenceKey */
export function plantInvoiceSequenceKey(plantNameId, billable = true) {
  const id = String(plantNameId);
  return billable ? `inv_plant:${id}` : `inv_plant_nb:${id}`;
}

const DEFAULT_INV_PREFIX = { billable: "INV", nonBillable: "INN" };

export function globalInvoiceSequenceKey(billable = true) {
  return billable !== false ? INV_BILLABLE_SEQUENCE_KEY : INV_NON_BILLABLE_SEQUENCE_KEY;
}

function defaultInvPrefix(billable = true) {
  return billable !== false ? DEFAULT_INV_PREFIX.billable : DEFAULT_INV_PREFIX.nonBillable;
}

/**
 * Allocate next official tax-invoice number from the global billable or non-billable bucket.
 */
export async function allocateOfficialInvoiceNumber(session, billable = true) {
  const isBillable = billable !== false;
  const fullKey = globalInvoiceSequenceKey(isBillable);
  const sess = session || undefined;

  const existing = await InvoiceSequence.findOne({ key: fullKey }).session(sess).lean();
  if (!existing) {
    await InvoiceSequence.updateOne(
      { key: fullKey },
      {
        $setOnInsert: {
          key: fullKey,
          prefix: defaultInvPrefix(isBillable),
          nextNumber: 1,
        },
      },
      { upsert: true, session: sess }
    );
  }

  const updated = await InvoiceSequence.findOneAndUpdate(
    { key: fullKey },
    { $inc: { nextNumber: 1 } },
    { new: true, session: sess }
  ).lean();

  if (!updated) {
    throw new Error("allocateOfficialInvoiceNumber: sequence document missing");
  }

  const seq = Math.max(1, Number(updated.nextNumber) - 1);
  const prefix =
    updated.prefix != null && String(updated.prefix).trim() !== ""
      ? String(updated.prefix).trim()
      : defaultInvPrefix(isBillable);
  return `${prefix}${seq}`;
}

/**
 * Allocate billable and/or non-billable official invoice numbers as needed (idempotent).
 * @returns {{ billable: string|null, nonBillable: string|null }}
 */
export async function ensureOfficialInvoicesForOrder(orderDoc, session) {
  const existingBillable = String(orderDoc?.officialInvoiceNumber || "").trim();
  const existingNonBillable = String(orderDoc?.officialNonBillableInvoiceNumber || "").trim();

  let buckets;
  try {
    buckets = await resolveOrderDcBillableBuckets(orderDoc, session);
  } catch (e) {
    console.error("ensureOfficialInvoicesForOrder: classify failed", e?.message || e);
    return {
      billable: existingBillable || null,
      nonBillable: existingNonBillable || null,
    };
  }

  let billable = existingBillable || null;
  let nonBillable = existingNonBillable || null;

  try {
    if (buckets.hasBillable && !billable) {
      billable = await allocateOfficialInvoiceNumber(session, true);
    }
    if (buckets.hasNonBillable && !nonBillable) {
      nonBillable = await allocateOfficialInvoiceNumber(session, false);
    }
  } catch (e) {
    console.error("ensureOfficialInvoicesForOrder:", e?.message || e);
  }

  return { billable, nonBillable };
}

/**
 * Apply ensure result onto a `$set` object (mutates and returns setFields).
 */
export async function ensureOfficialInvoiceSetFields(orderDoc, session) {
  const invs = await ensureOfficialInvoicesForOrder(orderDoc, session);
  const setFields = {};
  if (invs.billable && !String(orderDoc?.officialInvoiceNumber || "").trim()) {
    setFields.officialInvoiceNumber = invs.billable;
  }
  if (invs.nonBillable && !String(orderDoc?.officialNonBillableInvoiceNumber || "").trim()) {
    setFields.officialNonBillableInvoiceNumber = invs.nonBillable;
  }
  const primaryLabel = invs.billable || invs.nonBillable || null;
  return { ...invs, primaryLabel, setFields };
}

/**
 * Parse duplicate/regenerate overrides from request body.
 */
export function normalizeInvoiceNumberOverrides(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return new Map();
  const out = new Map();
  for (const [orderId, val] of Object.entries(raw)) {
    const id = String(orderId || "").trim();
    if (!id) continue;
    if (val == null) continue;
    if (typeof val === "string" || typeof val === "number") {
      const s = String(val).trim();
      if (s) out.set(id, { billable: s, nonBillable: undefined });
      continue;
    }
    if (typeof val === "object") {
      const billable =
        val.billable != null && String(val.billable).trim() !== ""
          ? String(val.billable).trim()
          : undefined;
      const nonBillable =
        val.nonBillable != null && String(val.nonBillable).trim() !== ""
          ? String(val.nonBillable).trim()
          : undefined;
      if (billable || nonBillable) out.set(id, { billable, nonBillable });
    }
  }
  return out;
}

/**
 * Persist manual invoice overrides for duplicate flow (does not consume sequence).
 */
export async function applyInvoiceNumberOverrides(orderId, override, session) {
  if (!override || (!override.billable && !override.nonBillable)) return null;
  const Order = (await import("../models/order.model.js")).default;
  const sess = session || undefined;
  const $set = {};
  if (override.billable) $set.manualInvoiceNumber = override.billable;
  if (override.nonBillable) $set.manualNonBillableInvoiceNumber = override.nonBillable;
  if (!Object.keys($set).length) return null;
  return Order.findByIdAndUpdate(orderId, { $set }, { new: true, session: sess })
    .select(
      "officialInvoiceNumber officialNonBillableInvoiceNumber manualInvoiceNumber manualNonBillableInvoiceNumber"
    )
    .lean();
}

import {
  createCustomerLedgerEntry,
  normalizeAgriCustomerMobile,
} from "../../utils/ramAgriLedgerHelper.js";
import RamAgriCustomerLedgerEntry from "../../models/ramAgriCustomerLedger.model.js";

/**
 * Post Ram Agri customer AR via existing collection, with idempotency.
 * Stores idempotencyKey in metadata.idempotencyKey and skips if present.
 */
export async function postAgriCustomerEntry({
  customerMobile,
  customerName,
  refType,
  refId,
  orderId,
  paymentId,
  debit = 0,
  credit = 0,
  reference,
  category,
  description,
  entryDate,
  createdBy,
  metadata = {},
  idempotencyKey,
  session,
} = {}) {
  const mobile = normalizeAgriCustomerMobile(customerMobile) || String(customerMobile || "").trim();
  if (!mobile) return { ok: false, error: "customerMobile required", status: 400 };

  const key = idempotencyKey || null;
  if (key) {
    const existing = await RamAgriCustomerLedgerEntry.findOne({
      "metadata.idempotencyKey": key,
    })
      .session(session || null)
      .lean();
    if (existing) {
      return { ok: true, entry: existing, created: false };
    }
  }

  const entry = await createCustomerLedgerEntry({
    customerMobile: mobile,
    customerName,
    refType,
    refId,
    orderId,
    paymentId,
    debit,
    credit,
    reference,
    category,
    description,
    entryDate,
    createdBy,
    metadata: key ? { ...metadata, idempotencyKey: key } : metadata,
    session,
  });

  if (!entry) return { ok: false, error: "No entry created", status: 400 };
  return { ok: true, entry, created: true };
}

export { normalizeAgriCustomerMobile };

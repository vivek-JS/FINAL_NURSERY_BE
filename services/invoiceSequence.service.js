import InvoiceSequence, { DELIVERY_CHALLAN_SEQUENCE_KEY } from "../models/invoiceSequence.model.js";

/**
 * Atomically reserve `count` consecutive invoice numbers. Returns formatted strings, e.g. ["R640","R641"].
 * Does not change already-issued values on orders; only moves the global counter.
 */
export async function allocateNextInvoiceNumbers(session, count) {
  const n = Math.max(0, Math.floor(Number(count) || 0));
  if (n < 1) return [];

  const sess = session || undefined;

  await InvoiceSequence.updateOne(
    { key: DELIVERY_CHALLAN_SEQUENCE_KEY },
    { $setOnInsert: { prefix: "R", nextNumber: 1 } },
    { upsert: true, session: sess }
  );

  const updated = await InvoiceSequence.findOneAndUpdate(
    { key: DELIVERY_CHALLAN_SEQUENCE_KEY },
    { $inc: { nextNumber: n } },
    { new: true, session: sess }
  ).lean();

  if (!updated) {
    throw new Error("Failed to reserve invoice numbers");
  }

  const endExclusive = updated.nextNumber;
  const start = endExclusive - n;
  const prefix = updated.prefix != null && String(updated.prefix).trim() !== ""
    ? String(updated.prefix).trim()
    : "R";

  const out = [];
  for (let v = start; v < endExclusive; v += 1) {
    out.push(`${prefix}${v}`);
  }
  return out;
}

export async function getInvoiceSequenceSettings() {
  const doc = await InvoiceSequence.findOne({ key: DELIVERY_CHALLAN_SEQUENCE_KEY }).lean();
  if (!doc) {
    return { key: DELIVERY_CHALLAN_SEQUENCE_KEY, prefix: "R", nextNumber: 1 };
  }
  return {
    key: doc.key,
    prefix: doc.prefix != null && String(doc.prefix).trim() !== "" ? String(doc.prefix).trim() : "R",
    nextNumber: Number(doc.nextNumber) || 1,
    updatedAt: doc.updatedAt,
  };
}

export async function setInvoiceSequenceSettings({ prefix, nextNumber }) {
  const p =
    prefix != null && String(prefix).trim() !== ""
      ? String(prefix).trim().slice(0, 24)
      : "R";
  const nn = Math.max(1, Math.floor(Number(nextNumber) || 1));

  const updated = await InvoiceSequence.findOneAndUpdate(
    { key: DELIVERY_CHALLAN_SEQUENCE_KEY },
    { $set: { prefix: p, nextNumber: nn } },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  ).lean();

  return {
    key: updated.key,
    prefix: updated.prefix,
    nextNumber: updated.nextNumber,
    updatedAt: updated.updatedAt,
  };
}

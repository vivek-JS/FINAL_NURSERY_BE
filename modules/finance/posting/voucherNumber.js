import FinanceVoucher from "../ledger/models/financeVoucher.model.js";
import JournalEntry from "../ledger/models/journalEntry.model.js";
import FinanceSequence from "../ledger/models/financeSequence.model.js";

function currentYear() {
  return new Date().getUTCFullYear();
}

function parseSeqFromNumber(fieldValue) {
  if (!fieldValue) return 0;
  const parts = String(fieldValue).split("-");
  const seq = parseInt(parts[parts.length - 1], 10);
  return Number.isNaN(seq) ? 0 : seq;
}

/**
 * Bootstrap counter from highest existing number so new sequences continue safely.
 */
async function ensureSequenceFloor(tenantId, key, prefix, field, model) {
  const year = currentYear();
  const last = await model
    .findOne({ tenantId, [field]: { $regex: `^${prefix}-${year}-` } })
    .sort({ [field]: -1 })
    .select(field)
    .lean();
  const floor = parseSeqFromNumber(last?.[field]);
  if (floor <= 0) return;
  await FinanceSequence.findOneAndUpdate(
    { tenantId, key },
    { $max: { seq: floor } },
    { upsert: true, setDefaultsOnInsert: true }
  );
}

async function nextAtomicSeq(tenantId, key, prefix, field, model) {
  await ensureSequenceFloor(tenantId, key, prefix, field, model);
  const doc = await FinanceSequence.findOneAndUpdate(
    { tenantId, key },
    { $inc: { seq: 1 } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
  const year = currentYear();
  return `${prefix}-${year}-${String(doc.seq).padStart(6, "0")}`;
}

export async function generateVoucherNo(voucherType, tenantId = "default") {
  const prefix = voucherType.slice(0, 3).toUpperCase();
  const year = currentYear();
  const key = `VCH:${prefix}:${year}`;
  return nextAtomicSeq(tenantId, key, prefix, "voucherNo", FinanceVoucher);
}

export async function generateJournalNo(tenantId = "default") {
  const prefix = "JE";
  const year = currentYear();
  const key = `JE:${year}`;
  return nextAtomicSeq(tenantId, key, prefix, "journalNo", JournalEntry);
}

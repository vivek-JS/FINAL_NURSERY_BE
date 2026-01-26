import RamAgriCustomerLedgerEntry from "../models/ramAgriCustomerLedger.model.js";

export const createCustomerLedgerEntry = async ({
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
  session,
}) => {
  if (!customerMobile) {
    return null;
  }

  const normalizedDebit = Math.abs(Number(debit || 0));
  const normalizedCredit = Math.abs(Number(credit || 0));

  if (normalizedDebit === 0 && normalizedCredit === 0) {
    return null;
  }

  const entryPayload = {
    customerMobile: customerMobile.trim(),
    customerName: customerName?.trim() || "",
    entryDate: entryDate ? new Date(entryDate) : new Date(),
    refType,
    refId,
    orderId,
    paymentId,
    debit: normalizedDebit,
    credit: normalizedCredit,
    reference,
    category,
    description,
    createdBy,
    metadata,
  };

  if (session) {
    const created = await RamAgriCustomerLedgerEntry.create([entryPayload], { session });
    return created[0];
  }

  return RamAgriCustomerLedgerEntry.create(entryPayload);
};

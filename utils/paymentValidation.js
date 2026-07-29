export function normalizePositiveAmount(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  return amount;
}

export function roundMoneyAmount(value) {
  return Math.round(Number(value) * 100) / 100;
}

function normalizedIdentifier(value) {
  const text = value == null ? "" : String(value).trim();
  return text || null;
}

export function normalizeQrPaymentCallback(body = {}) {
  const referenceId = normalizedIdentifier(body.referenceId);
  const utr = normalizedIdentifier(body.utr);
  const amount = normalizePositiveAmount(body.amount);

  if (!referenceId && !utr) {
    return {
      ok: false,
      message: "referenceId or utr required",
    };
  }

  if (amount == null) {
    return {
      ok: false,
      message: "amount must be greater than 0",
    };
  }

  return {
    ok: true,
    referenceId,
    utr,
    amount: roundMoneyAmount(amount),
  };
}

export function qrPaymentSubdocMatches(payment, callback, now = new Date()) {
  if (!payment || payment.paymentStatus !== "PENDING") return false;
  if (payment.qrExpiresAt && new Date(payment.qrExpiresAt) < now) return false;

  const paidAmount = roundMoneyAmount(payment.paidAmount);
  if (paidAmount !== callback.amount) return false;

  const matchReference =
    callback.referenceId &&
    payment.qrReferenceId &&
    String(payment.qrReferenceId).trim() === callback.referenceId;
  const matchUtr =
    callback.utr &&
    ((payment.utrNumber && String(payment.utrNumber).trim() === callback.utr) ||
      (payment.transactionId && String(payment.transactionId).trim() === callback.utr));

  return Boolean(matchReference || matchUtr);
}

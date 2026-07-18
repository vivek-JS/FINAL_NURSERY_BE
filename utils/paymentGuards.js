export function parsePositivePaymentAmount(value) {
  const amount = Number(value);
  return Number.isFinite(amount) && amount > 0 ? amount : null;
}

export function parsePositiveRoundedPaymentAmount(value) {
  const amount = parsePositivePaymentAmount(value);
  return amount == null ? null : Math.round(amount * 100) / 100;
}

export function normalizeQrPaymentCallbackInput(body = {}) {
  const referenceId = String(body.referenceId ?? "").trim();
  const utr = String(body.utr ?? "").trim();
  const amount = parsePositiveRoundedPaymentAmount(body.amount);
  const ref = referenceId || utr;

  return {
    ref,
    referenceId,
    utr,
    amount,
    isValid: Boolean(ref && amount != null),
  };
}

export function buildQrPaymentCallbackQuery(callbackInput) {
  return {
    "payment.paymentStatus": "PENDING",
    "payment.qrReferenceId": callbackInput.ref,
    "payment.paidAmount": callbackInput.amount,
  };
}

export function qrPaymentMatchesCallback(payment, callbackInput, now = new Date()) {
  if (!payment || payment.paymentStatus !== "PENDING") return false;
  if (payment.qrExpiresAt && new Date(payment.qrExpiresAt) < now) return false;

  const paymentRef = String(payment.qrReferenceId ?? "").trim();
  const paymentAmount = parsePositiveRoundedPaymentAmount(payment.paidAmount);

  return (
    Boolean(paymentRef) &&
    paymentRef === callbackInput.ref &&
    paymentAmount != null &&
    paymentAmount === callbackInput.amount
  );
}

function cleanText(value) {
  if (value == null) return "";
  return String(value).trim();
}

function roundMoney(value) {
  return Math.round(Number(value) * 100) / 100;
}

function sameText(a, b) {
  const left = cleanText(a);
  const right = cleanText(b);
  return Boolean(left && right && left === right);
}

function sameAmount(a, b) {
  return Number.isFinite(Number(a)) && roundMoney(a) === b;
}

export function normalizeQrPaymentCallbackPayload(body = {}) {
  const referenceId = cleanText(body.referenceId);
  const utr = cleanText(body.utr);
  const amountProvided =
    body.amount != null && !(typeof body.amount === "string" && body.amount.trim() === "");
  let amount = null;

  if (amountProvided) {
    const parsed = Number(body.amount);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return { ok: false, message: "amount must be a positive number" };
    }
    amount = roundMoney(parsed);
  }

  if (!referenceId && (!utr || amount == null)) {
    return {
      ok: false,
      message: "referenceId or utr with positive amount required",
    };
  }

  return { ok: true, referenceId, utr, amount };
}

export function buildQrPaymentCallbackQuery(criteria) {
  const q = { "payment.paymentStatus": "PENDING" };
  if (criteria.referenceId) {
    q.$or = [
      { "payment.qrReferenceId": criteria.referenceId },
      { "payment.merchantTranId": criteria.referenceId },
    ];
  } else {
    q.$or = [
      { "payment.transactionId": criteria.utr },
      { "payment.utrNumber": criteria.utr },
      { "payment.providerTxnId": criteria.utr },
      { "payment.bankReferenceNumber": criteria.utr },
    ];
  }
  if (criteria.amount != null) q["payment.paidAmount"] = criteria.amount;
  return q;
}

export function paymentMatchesQrCallback(payment, criteria, now = new Date()) {
  if (!payment || payment.paymentStatus !== "PENDING") return false;
  if (payment.qrExpiresAt && new Date(payment.qrExpiresAt) < now) return false;

  if (criteria.amount != null && !sameAmount(payment.paidAmount, criteria.amount)) {
    return false;
  }

  if (criteria.referenceId) {
    return (
      sameText(payment.qrReferenceId, criteria.referenceId) ||
      sameText(payment.merchantTranId, criteria.referenceId)
    );
  }

  return (
    sameText(payment.transactionId, criteria.utr) ||
    sameText(payment.utrNumber, criteria.utr) ||
    sameText(payment.providerTxnId, criteria.utr) ||
    sameText(payment.bankReferenceNumber, criteria.utr)
  );
}

export function markPaymentBankVerified(payment, criteria) {
  payment.paymentStatus = "BANK_VERIFIED";
  if (criteria.utr) payment.transactionId = criteria.utr;
}

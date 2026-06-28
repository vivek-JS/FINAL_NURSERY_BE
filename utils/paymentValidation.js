function normalizeText(value) {
  const text = value == null ? "" : String(value).trim();
  return text || null;
}

function roundMoney(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return null;
  return Math.round(amount * 100) / 100;
}

export function parsePositivePaymentAmount(value) {
  const amount = roundMoney(value);
  return amount != null && amount > 0 ? amount : null;
}

export function parseQrPaymentCallbackPayload(body = {}) {
  const referenceId = normalizeText(body.referenceId);
  const utr = normalizeText(body.utr);
  const rawAmount = body.amount;
  const amountProvided =
    rawAmount !== undefined && rawAmount !== null && String(rawAmount).trim() !== "";
  const amount = amountProvided ? parsePositivePaymentAmount(rawAmount) : null;

  if (amountProvided && amount == null) {
    return {
      ok: false,
      status: 400,
      message: "amount must be a positive number",
    };
  }

  if (referenceId) {
    return {
      ok: true,
      referenceId,
      utr,
      ref: referenceId,
      amount,
    };
  }

  if (utr && amount != null) {
    return {
      ok: true,
      referenceId,
      utr,
      ref: utr,
      amount,
    };
  }

  return {
    ok: false,
    status: 400,
    message: "referenceId or (utr and amount) required",
  };
}

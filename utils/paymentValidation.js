export function parsePositivePaymentAmount(value, fieldName = "amount") {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0) {
    return {
      ok: false,
      message: `${fieldName} must be greater than 0`,
    };
  }
  return { ok: true, amount };
}

export function roundMoney(value) {
  return Math.round(Number(value) * 100) / 100;
}

export function parseQrPaymentCallbackPayload(body = {}) {
  const referenceId = body.referenceId ? String(body.referenceId).trim() : "";
  const utr = body.utr ? String(body.utr).trim() : "";

  if (!referenceId && !utr) {
    return {
      ok: false,
      message: "referenceId or utr is required",
    };
  }

  const parsedAmount = parsePositivePaymentAmount(body.amount, "amount");
  if (!parsedAmount.ok) {
    return parsedAmount;
  }

  return {
    ok: true,
    referenceId,
    utr,
    ref: referenceId || utr,
    amount: roundMoney(parsedAmount.amount),
  };
}

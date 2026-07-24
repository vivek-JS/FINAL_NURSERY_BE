export function parsePositivePaymentAmount(value, fieldName = "amount") {
  const amount = Number(value);
  const rounded = Math.round(amount * 100) / 100;
  if (!Number.isFinite(amount) || !Number.isFinite(rounded) || rounded <= 0) {
    return {
      ok: false,
      message: `${fieldName} must be a positive amount`,
    };
  }
  return { ok: true, amount: rounded };
}

export function normalizeQrPaymentCallbackPayload(body = {}) {
  const referenceId =
    body.referenceId != null && String(body.referenceId).trim() !== ""
      ? String(body.referenceId).trim()
      : "";
  const utr =
    body.utr != null && String(body.utr).trim() !== ""
      ? String(body.utr).trim()
      : "";
  const hasAmount =
    body.amount != null && String(body.amount).trim() !== "";

  if (!referenceId && !utr) {
    return {
      ok: false,
      message: "referenceId or utr with amount is required",
    };
  }

  let amount = null;
  if (hasAmount) {
    const parsed = parsePositivePaymentAmount(body.amount, "amount");
    if (!parsed.ok) return parsed;
    amount = parsed.amount;
  }

  if (!referenceId && utr && amount == null) {
    return {
      ok: false,
      message: "amount is required when matching by utr",
    };
  }

  return {
    ok: true,
    reference: referenceId || utr,
    utr,
    amount,
  };
}

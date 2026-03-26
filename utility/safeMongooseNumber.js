import mongoose from "mongoose";

/**
 * Coerce Mongoose/BSON values (Decimal128, Long, etc.) to a finite integer.
 * Plain Number() on Decimal128 often yields NaN.
 */
export function safeMongooseNumber(v) {
  if (v == null || v === "") return NaN;
  if (typeof v === "number") {
    return Number.isFinite(v) ? Math.trunc(v) : NaN;
  }
  const Types = mongoose.Types;
  if (Types.Decimal128 && typeof Types.Decimal128.isDecimal128 === "function") {
    if (Types.Decimal128.isDecimal128(v)) {
      const n = parseFloat(v.toString());
      return Number.isFinite(n) ? Math.trunc(n) : NaN;
    }
  }
  if (typeof v === "object" && v != null && typeof v.toString === "function") {
    const s = String(v).replace(/,/g, "").trim();
    if (s === "") return NaN;
    const n = parseFloat(s);
    return Number.isFinite(n) ? Math.trunc(n) : NaN;
  }
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : NaN;
}

export function safeNonNegativeInt(v, fallback = 0) {
  const n = safeMongooseNumber(v);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return n;
}

/**
 * Safe a - b for stock math: avoids NaN from Infinity - Infinity or bad floats.
 */
export function safeSubtractNonNegative(a, b) {
  const x = Number(a);
  const y = Number(b);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return 0;
  const d = x - y;
  if (!Number.isFinite(d)) return 0;
  return Math.max(0, Math.trunc(d));
}

/** Integer in [0, MAX_SAFE_INTEGER] for Mongoose Number paths — never NaN/Infinity. */
export function clampUintForDb(n) {
  const x = typeof n === "number" ? n : Number(n);
  if (!Number.isFinite(x) || x < 0) return 0;
  return Math.min(Number.MAX_SAFE_INTEGER, Math.trunc(x));
}

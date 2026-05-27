const SENSITIVE = ["password", "secret", "token", "apikey", "encryptedkey", "encrypteddata", "utr", "account"];

export function maskValue(key, value) {
  if (value == null) return value;
  const k = String(key).toLowerCase();
  if (SENSITIVE.some((s) => k.includes(s))) {
    const s = String(value);
    return s.length <= 4 ? "****" : `${s.slice(0, 2)}****${s.slice(-2)}`;
  }
  return value;
}

export function maskObject(obj, depth = 0) {
  if (obj == null || depth > 5) return obj;
  if (Array.isArray(obj)) return obj.map((v) => maskObject(v, depth + 1));
  if (typeof obj !== "object") return obj;
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k] = v && typeof v === "object" ? maskObject(v, depth + 1) : maskValue(k, v);
  }
  return out;
}

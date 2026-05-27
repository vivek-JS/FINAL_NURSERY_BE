const SENSITIVE_KEYS = [
  "password",
  "secret",
  "token",
  "apiKey",
  "api_key",
  "encryptedKey",
  "encryptedData",
  "privateKey",
  "authorization",
  "utr",
  "accountNumber",
  "account_number",
];

export function maskValue(key, value) {
  if (value == null) return value;
  const k = String(key).toLowerCase();
  if (SENSITIVE_KEYS.some((s) => k.includes(s.toLowerCase()))) {
    const str = String(value);
    if (str.length <= 4) return "****";
    return `${str.slice(0, 2)}****${str.slice(-2)}`;
  }
  return value;
}

export function maskSensitiveObject(obj, depth = 0) {
  if (obj == null || depth > 6) return obj;
  if (Array.isArray(obj)) return obj.map((v) => maskSensitiveObject(v, depth + 1));
  if (typeof obj !== "object") return obj;

  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v && typeof v === "object") {
      out[k] = maskSensitiveObject(v, depth + 1);
    } else {
      out[k] = maskValue(k, v);
    }
  }
  return out;
}

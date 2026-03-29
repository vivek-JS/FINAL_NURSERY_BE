import crypto from "crypto";

/**
 * Generate a unique merchant transaction id for ICICI (alphanumeric, reasonable length).
 */
export function generateMerchantTranId(prefix = "MT") {
  const ts = Date.now().toString(36).toUpperCase();
  const rnd = crypto.randomBytes(6).toString("hex").toUpperCase();
  return `${prefix}${ts}${rnd}`.slice(0, 40);
}

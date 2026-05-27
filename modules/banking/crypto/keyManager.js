import fs from "fs";
import forge from "node-forge";
import { getIciciCorporateConfig } from "../config/iciciCorporate.config.js";

let cachedKeys = null;
let cachedAt = 0;
const CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * Load RSA key material from disk. Supports PEM private key and X.509 public certs.
 * Cache is invalidated every 5 minutes to support certificate rotation without restart.
 */
export function loadKeyMaterial(forceReload = false) {
  const now = Date.now();
  if (!forceReload && cachedKeys && now - cachedAt < CACHE_TTL_MS) {
    return cachedKeys;
  }

  const { keys } = getIciciCorporateConfig();
  const result = {
    privateKey: null,
    publicCert: null,
    iciciPublicCert: null,
    loadedAt: new Date().toISOString(),
  };

  if (keys.privateKeyPath && fs.existsSync(keys.privateKeyPath)) {
    const pem = fs.readFileSync(keys.privateKeyPath, "utf8");
    result.privateKey = forge.pki.privateKeyFromPem(pem);
  }

  if (keys.publicCertPath && fs.existsSync(keys.publicCertPath)) {
    const pem = fs.readFileSync(keys.publicCertPath, "utf8");
    result.publicCert = forge.pki.certificateFromPem(pem);
  }

  if (keys.iciciPublicCertPath && fs.existsSync(keys.iciciPublicCertPath)) {
    const pem = fs.readFileSync(keys.iciciPublicCertPath, "utf8");
    result.iciciPublicCert = forge.pki.certificateFromPem(pem);
  }

  cachedKeys = result;
  cachedAt = now;
  return result;
}

export function assertKeysForEncryption() {
  const keys = loadKeyMaterial();
  if (!keys.iciciPublicCert) {
    const err = new Error(
      "ICICI bank public certificate not found — set ICICI_BANK_PUBLIC_CERT_PATH"
    );
    err.code = "ICICI_CERT_MISSING";
    throw err;
  }
  if (!keys.privateKey) {
    const err = new Error("Local private key not found — set ICICI_PRIVATE_KEY_PATH");
    err.code = "ICICI_KEY_MISSING";
    throw err;
  }
  return keys;
}

export function getPublicKeyFingerprint(cert) {
  if (!cert) return null;
  const asn1 = forge.pki.certificateToAsn1(cert);
  const der = forge.asn1.toDer(asn1).getBytes();
  const md = forge.md.sha256.create();
  md.update(der);
  return md.digest().toHex().slice(0, 16);
}

export function invalidateKeyCache() {
  cachedKeys = null;
  cachedAt = 0;
}

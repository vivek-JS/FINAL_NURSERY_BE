import crypto from "crypto";
import forge from "node-forge";
import { assertKeysForEncryption } from "./keyManager.js";

/**
 * HYBRID ENCRYPTION FLOW (ICICI Corporate API standard pattern)
 * =============================================================
 *
 * OUTBOUND (request to ICICI):
 *   1. Serialize payload to JSON
 *   2. Generate random AES-256 key (32 bytes) + IV (16 bytes)
 *   3. Encrypt payload with AES-256-CBC → encryptedData (base64)
 *   4. Encrypt AES key with ICICI RSA-4096 public cert (RSA-OAEP SHA-256) → encryptedKey (base64)
 *   5. Send { encryptedKey, encryptedData, iv, oaepHashingAlgorithm: "SHA256" }
 *
 * INBOUND (response from ICICI):
 *   1. Receive { encryptedKey, encryptedData, iv }
 *   2. Decrypt encryptedKey with local RSA private key (RSA-OAEP SHA-256)
 *   3. Decrypt encryptedData with recovered AES key
 *   4. Parse JSON payload
 *
 * Why hybrid? RSA is slow for large payloads; AES handles bulk data; RSA secures the AES key.
 */

/**
 * CIB_SV MODE (ICICI UAT mail, SR285629874)
 * =========================================
 * The CIB_SV sandbox uses a different scheme to the OAEP flow above:
 *   1. RANDOMNO1 = 16 random digits, used directly as the AES-128 key
 *   2. encryptedKey = base64(RSA/ECB/PKCS1(RANDOMNO1))
 *   3. RANDOMNO2 = 16 random digits, used as the IV
 *   4. encryptedData = base64(AES/CBC/PKCS5(RANDOMNO2 + json, RANDOMNO1, RANDOMNO2))
 * The envelope carries `oaepHashingAlgorithm: "NONE"` and an empty `iv` field,
 * because the IV travels inside the payload rather than beside it.
 *
 * On the way back the bank prepends the raw IV to the ciphertext, so decrypting
 * the whole blob yields one garbage block first — that is the 16 bytes the bank's
 * instructions tell us to discard.
 */

const AES_ALGO = "aes-256-cbc";
const AES_ALGO_CIB_SV = "aes-128-cbc";
const RSA_PADDING = crypto.constants.RSA_PKCS1_OAEP_PADDING;
const RSA_PADDING_CIB_SV = crypto.constants.RSA_PKCS1_PADDING;
const OAEP_HASH = "sha256";
const CIB_SV_BLOCK_BYTES = 16;

/** True when the CIB_SV (UAT) scheme is selected instead of the OAEP scheme. */
export function isCibSvCryptoMode() {
  return String(process.env.ICICI_CRYPTO_MODE || "").toUpperCase() === "CIB_SV";
}

/** 16 random digits as ASCII — doubles as a 16-byte AES key or IV. */
function random16Digits() {
  let out = "";
  for (let i = 0; i < CIB_SV_BLOCK_BYTES; i += 1) {
    out += String(crypto.randomInt(0, 10));
  }
  return Buffer.from(out, "utf8");
}

function forgePrivateKeyToNode(forgePrivateKey) {
  const pem = forge.pki.privateKeyToPem(forgePrivateKey);
  return crypto.createPrivateKey(pem);
}

function forgePublicKeyToNode(forgeCert) {
  const pem = forge.pki.publicKeyToPem(forgeCert.publicKey);
  return crypto.createPublicKey(pem);
}

/**
 * Encrypt a plain object for ICICI Corporate API (OAEP SHA-256 scheme).
 * @param {object} payload
 * @returns {{ encryptedKey: string, encryptedData: string, iv: string, oaepHashingAlgorithm: string }}
 */
function encryptPayloadOaep(payload) {
  const { iciciPublicCert, privateKey } = assertKeysForEncryption();

  const plainText = JSON.stringify(payload);
  const aesKey = crypto.randomBytes(32);
  const iv = crypto.randomBytes(16);

  const cipher = crypto.createCipheriv(AES_ALGO, aesKey, iv);
  let encryptedData = cipher.update(plainText, "utf8", "base64");
  encryptedData += cipher.final("base64");

  const iciciPublicKey = forgePublicKeyToNode(iciciPublicCert);
  const encryptedKey = crypto.publicEncrypt(
    { key: iciciPublicKey, padding: RSA_PADDING, oaepHash: OAEP_HASH },
    aesKey
  );

  return {
    encryptedKey: encryptedKey.toString("base64"),
    encryptedData,
    iv: iv.toString("base64"),
    oaepHashingAlgorithm: "SHA256",
    requestId: crypto.randomUUID(),
    requestTimestamp: new Date().toISOString(),
  };
}

/**
 * Encrypt a plain object for the CIB_SV sandbox (PKCS1 + in-payload IV).
 * @param {object} payload
 * @returns {{ requestId: string, service: string, encryptedKey: string, encryptedData: string, oaepHashingAlgorithm: string, iv: string, clientInfo: string, optionalParam: string }}
 */
function encryptPayloadCibSv(payload, { service = "" } = {}) {
  const { iciciPublicCert } = assertKeysForEncryption();

  const aesKey = random16Digits();
  const iv = random16Digits();

  const cipher = crypto.createCipheriv(AES_ALGO_CIB_SV, aesKey, iv);
  const encryptedData = Buffer.concat([
    cipher.update(Buffer.concat([iv, Buffer.from(JSON.stringify(payload), "utf8")])),
    cipher.final(),
  ]).toString("base64");

  const encryptedKey = crypto.publicEncrypt(
    { key: forgePublicKeyToNode(iciciPublicCert), padding: RSA_PADDING_CIB_SV },
    aesKey
  );

  return {
    requestId: crypto.randomUUID(),
    service,
    encryptedKey: encryptedKey.toString("base64"),
    encryptedData,
    oaepHashingAlgorithm: "NONE",
    iv: "",
    clientInfo: "",
    optionalParam: "",
  };
}

/**
 * Encrypt a plain object for ICICI. Scheme follows `ICICI_CRYPTO_MODE`.
 * @param {object} payload
 * @param {{ service?: string }} [options]
 */
export function encryptPayload(payload, options = {}) {
  return isCibSvCryptoMode()
    ? encryptPayloadCibSv(payload, options)
    : encryptPayloadOaep(payload);
}

/**
 * Decrypt ICICI Corporate API response envelope (OAEP SHA-256 scheme).
 * @param {{ encryptedKey: string, encryptedData: string, iv: string }} envelope
 * @returns {object}
 */
function decryptPayloadOaep(envelope) {
  const { privateKey } = assertKeysForEncryption();

  if (!envelope?.encryptedKey || !envelope?.encryptedData || !envelope?.iv) {
    const err = new Error("Invalid encrypted envelope — missing encryptedKey, encryptedData, or iv");
    err.code = "ICICI_DECRYPT_INVALID";
    throw err;
  }

  const nodePrivateKey = forgePrivateKeyToNode(privateKey);
  const aesKey = crypto.privateDecrypt(
    { key: nodePrivateKey, padding: RSA_PADDING, oaepHash: OAEP_HASH },
    Buffer.from(envelope.encryptedKey, "base64")
  );

  const iv = Buffer.from(envelope.iv, "base64");
  const decipher = crypto.createDecipheriv(AES_ALGO, aesKey, iv);
  let plain = decipher.update(envelope.encryptedData, "base64", "utf8");
  plain += decipher.final("utf8");

  return JSON.parse(plain);
}

/**
 * Decrypt a CIB_SV response envelope (PKCS1 key, IV prefixed to the ciphertext).
 * @param {{ encryptedKey: string, encryptedData: string }} envelope
 * @returns {object}
 */
function decryptPayloadCibSv(envelope) {
  const { privateKey } = assertKeysForEncryption();

  if (!envelope?.encryptedKey || !envelope?.encryptedData) {
    const err = new Error("Invalid encrypted envelope — missing encryptedKey or encryptedData");
    err.code = "ICICI_DECRYPT_INVALID";
    throw err;
  }

  const aesKey = crypto.privateDecrypt(
    { key: forgePrivateKeyToNode(privateKey), padding: RSA_PADDING_CIB_SV },
    Buffer.from(envelope.encryptedKey, "base64")
  );

  const raw = Buffer.from(envelope.encryptedData, "base64");
  const decipher = crypto.createDecipheriv(
    AES_ALGO_CIB_SV,
    aesKey,
    raw.subarray(0, CIB_SV_BLOCK_BYTES)
  );
  const plain = Buffer.concat([decipher.update(raw), decipher.final()]);

  // First block is the IV echoed back through CBC; the JSON starts after it.
  const text = plain.subarray(CIB_SV_BLOCK_BYTES).toString("utf8").trim();
  try {
    return JSON.parse(text);
  } catch {
    return JSON.parse(plain.toString("utf8").trim());
  }
}

/**
 * Decrypt an ICICI response envelope. Scheme follows `ICICI_CRYPTO_MODE`.
 * @param {{ encryptedKey: string, encryptedData: string, iv?: string }} envelope
 */
export function decryptPayload(envelope) {
  return isCibSvCryptoMode()
    ? decryptPayloadCibSv(envelope)
    : decryptPayloadOaep(envelope);
}

/**
 * Sign outbound request body for audit / optional bank verification.
 */
export function signPayload(payload, privateKeyForge) {
  const md = forge.md.sha256.create();
  md.update(JSON.stringify(payload), "utf8");
  const signature = privateKeyForge.sign(md);
  return forge.util.encode64(signature);
}

export function verifySignature(payload, signatureB64, publicCertForge) {
  const md = forge.md.sha256.create();
  md.update(JSON.stringify(payload), "utf8");
  return publicCertForge.publicKey.verify(
    md.digest().bytes(),
    forge.util.decode64(signatureB64)
  );
}

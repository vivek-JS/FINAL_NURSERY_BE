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

const AES_ALGO = "aes-256-cbc";
const RSA_PADDING = crypto.constants.RSA_PKCS1_OAEP_PADDING;
const OAEP_HASH = "sha256";

function forgePrivateKeyToNode(forgePrivateKey) {
  const pem = forge.pki.privateKeyToPem(forgePrivateKey);
  return crypto.createPrivateKey(pem);
}

function forgePublicKeyToNode(forgeCert) {
  const pem = forge.pki.publicKeyToPem(forgeCert.publicKey);
  return crypto.createPublicKey(pem);
}

/**
 * Encrypt a plain object for ICICI Corporate API.
 * @param {object} payload
 * @returns {{ encryptedKey: string, encryptedData: string, iv: string, oaepHashingAlgorithm: string }}
 */
export function encryptPayload(payload) {
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
 * Decrypt ICICI Corporate API response envelope.
 * @param {{ encryptedKey: string, encryptedData: string, iv: string }} envelope
 * @returns {object}
 */
export function decryptPayload(envelope) {
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

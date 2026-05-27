/**
 * ICICI Corporate API — modular encryption wrapper.
 *
 * Hybrid flow (default):
 *   1. Random AES-256 key + IV
 *   2. AES-256-CBC encrypt JSON payload
 *   3. RSA-OAEP (SHA-256) encrypt AES key with ICICI public cert
 *
 * Swap `activeWrapper` later if ICICI changes algorithm — business code stays unchanged.
 */

import crypto from "crypto";
import fs from "fs";
import path from "path";
import forge from "node-forge";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(__dirname, "../..");

const AES_ALGO = "aes-256-cbc";
const RSA_PADDING = crypto.constants.RSA_PKCS1_OAEP_PADDING;
const OAEP_HASH = "sha256";

let keyCache = null;
let keyCacheAt = 0;
const KEY_CACHE_TTL_MS = 5 * 60 * 1000;

function resolvePath(p) {
  if (!p) return null;
  if (path.isAbsolute(p)) return p;
  return path.join(projectRoot, p.replace(/^\.\//, ""));
}

export function getCertPaths() {
  return {
    privateKeyPath: resolvePath(process.env.ICICI_PRIVATE_KEY_PATH || "./keys/private.key"),
    publicCertPath: resolvePath(process.env.ICICI_PUBLIC_CERT_PATH || "./keys/public.crt"),
    iciciPublicCertPath: resolvePath(
      process.env.ICICI_BANK_PUBLIC_CERT_PATH || "./keys/icici_public.crt"
    ),
  };
}

function loadPem(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  return fs.readFileSync(filePath, "utf8");
}

/**
 * Load keys/certs from disk (cached 5 min for cert rotation without restart).
 */
export function loadCertificates(forceReload = false) {
  const now = Date.now();
  if (!forceReload && keyCache && now - keyCacheAt < KEY_CACHE_TTL_MS) {
    return keyCache;
  }

  const paths = getCertPaths();
  const privateKeyPem = loadPem(paths.privateKeyPath);
  const publicCertPem = loadPem(paths.publicCertPath);
  const iciciPublicCertPem = loadPem(paths.iciciPublicCertPath);

  keyCache = {
    paths,
    privateKeyPem,
    publicCertPem,
    iciciPublicCertPem,
    privateKey: privateKeyPem ? forge.pki.privateKeyFromPem(privateKeyPem) : null,
    publicCert: publicCertPem ? forge.pki.certificateFromPem(publicCertPem) : null,
    iciciPublicCert: iciciPublicCertPem
      ? forge.pki.certificateFromPem(iciciPublicCertPem)
      : null,
    loadedAt: new Date().toISOString(),
  };
  keyCacheAt = now;
  return keyCache;
}

export function getCertificateHealth() {
  const c = loadCertificates();
  return {
    privateKeyLoaded: Boolean(c.privateKey),
    publicCertLoaded: Boolean(c.publicCert),
    iciciPublicCertLoaded: Boolean(c.iciciPublicCert),
    paths: {
      privateKeyPath: c.paths.privateKeyPath,
      publicCertPath: c.paths.publicCertPath,
      iciciPublicCertPath: c.paths.iciciPublicCertPath,
    },
    filesExist: {
      privateKey: Boolean(c.privateKeyPem),
      publicCert: Boolean(c.publicCertPem),
      iciciPublicCert: Boolean(c.iciciPublicCertPem),
    },
    loadedAt: c.loadedAt,
    ready: Boolean(c.privateKey && c.iciciPublicCert),
  };
}

function forgePrivateToNode(forgeKey) {
  return crypto.createPrivateKey(forge.pki.privateKeyToPem(forgeKey));
}

function forgeCertPublicToNode(forgeCert) {
  return crypto.createPublicKey(forge.pki.publicKeyToPem(forgeCert.publicKey));
}

/** Default hybrid encrypt — swap via setEncryptionWrapper() if ICICI changes format */
function hybridEncrypt(plainObject) {
  const { iciciPublicCert, privateKey } = loadCertificates();
  if (!iciciPublicCert) {
    const e = new Error("ICICI bank public certificate not loaded");
    e.code = "ICICI_CERT_MISSING";
    throw e;
  }
  if (!privateKey) {
    const e = new Error("Local private key not loaded");
    e.code = "ICICI_KEY_MISSING";
    throw e;
  }

  const plainText = JSON.stringify(plainObject);
  const aesKey = crypto.randomBytes(32);
  const iv = crypto.randomBytes(16);

  const cipher = crypto.createCipheriv(AES_ALGO, aesKey, iv);
  let encryptedData = cipher.update(plainText, "utf8", "base64");
  encryptedData += cipher.final("base64");

  const iciciPub = forgeCertPublicToNode(iciciPublicCert);
  const encryptedKey = crypto.publicEncrypt(
    { key: iciciPub, padding: RSA_PADDING, oaepHash: OAEP_HASH },
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

function hybridDecrypt(envelope) {
  const { privateKey } = loadCertificates();
  if (!privateKey) {
    const e = new Error("Local private key not loaded");
    e.code = "ICICI_KEY_MISSING";
    throw e;
  }
  if (!envelope?.encryptedKey || !envelope?.encryptedData || !envelope?.iv) {
    const e = new Error("Invalid encrypted envelope from ICICI");
    e.code = "ICICI_DECRYPT_INVALID";
    throw e;
  }

  const nodePrivate = forgePrivateToNode(privateKey);
  const aesKey = crypto.privateDecrypt(
    { key: nodePrivate, padding: RSA_PADDING, oaepHash: OAEP_HASH },
    Buffer.from(envelope.encryptedKey, "base64")
  );

  const iv = Buffer.from(envelope.iv, "base64");
  const decipher = crypto.createDecipheriv(AES_ALGO, aesKey, iv);
  let plain = decipher.update(envelope.encryptedData, "base64", "utf8");
  plain += decipher.final("utf8");
  return JSON.parse(plain);
}

/** Plain pass-through for stub mode */
function passthroughEncrypt(obj) {
  return obj;
}
function passthroughDecrypt(obj) {
  return obj;
}

let activeWrapper = { encrypt: hybridEncrypt, decrypt: hybridDecrypt, name: "hybrid-rsa-aes256-cbc" };

export function setEncryptionWrapper(wrapper) {
  if (!wrapper?.encrypt || !wrapper?.decrypt) {
    throw new Error("Wrapper must provide encrypt() and decrypt()");
  }
  activeWrapper = wrapper;
}

export function getEncryptionWrapperName() {
  return activeWrapper.name || "custom";
}

export function encryptPayload(plainObject) {
  return activeWrapper.encrypt(plainObject);
}

export function decryptPayload(envelope) {
  if (envelope?.encryptedKey && envelope?.encryptedData) {
    return activeWrapper.decrypt(envelope);
  }
  return envelope;
}

export function usePassthroughEncryption() {
  activeWrapper = {
    encrypt: passthroughEncrypt,
    decrypt: passthroughDecrypt,
    name: "passthrough-stub",
  };
}

export function useHybridEncryption() {
  activeWrapper = { encrypt: hybridEncrypt, decrypt: hybridDecrypt, name: "hybrid-rsa-aes256-cbc" };
}

export function readPublicCertPem() {
  const c = loadCertificates();
  return c.publicCertPem;
}

export function invalidateCertCache() {
  keyCache = null;
  keyCacheAt = 0;
}

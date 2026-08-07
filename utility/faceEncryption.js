import crypto from "crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12; // recommended for GCM

function getKey() {
  const raw = process.env.FACE_EMBEDDING_ENCRYPTION_KEY;
  if (!raw) {
    throw new Error(
      "FACE_EMBEDDING_ENCRYPTION_KEY is not set. Generate one with `node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"` and set it in the environment."
    );
  }
  // Accept either a 64-char hex string or any string (hashed down to 32 bytes) for operator convenience.
  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    return Buffer.from(raw, "hex");
  }
  return crypto.createHash("sha256").update(raw).digest();
}

/**
 * Encrypts a Float32Array face descriptor for at-rest storage.
 * @param {Float32Array} descriptor
 * @returns {{ encryptedVector: string, iv: string, authTag: string }} base64/hex encoded parts
 */
export function encryptFaceDescriptor(descriptor) {
  const key = getKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  const plaintext = Buffer.from(Float32Array.from(descriptor).buffer);
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return {
    encryptedVector: encrypted.toString("base64"),
    iv: iv.toString("base64"),
    authTag: authTag.toString("base64"),
  };
}

/**
 * Decrypts a stored face descriptor back into a Float32Array.
 * @param {{ encryptedVector: string, iv: string, authTag: string }} record
 * @returns {Float32Array}
 */
export function decryptFaceDescriptor({ encryptedVector, iv, authTag }) {
  const key = getKey();
  const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(authTag, "base64"));

  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(encryptedVector, "base64")),
    decipher.final(),
  ]);

  // Copy into a dedicated, guaranteed-aligned ArrayBuffer — Buffer.concat's backing
  // buffer may come from Node's shared pool with a byteOffset that isn't a multiple
  // of 4, which Float32Array's constructor requires.
  const aligned = new Uint8Array(decrypted.length);
  aligned.set(decrypted);
  return new Float32Array(aligned.buffer);
}

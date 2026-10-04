/**
 * CIB_SV envelope crypto, exercised end to end against a throwaway key pair.
 *
 * The response half is what the sandbox actually sends back: the AES key under
 * RSA PKCS1 v1.5, and the IV in the clear ahead of the AES-CBC ciphertext.
 * Node will not do PKCS1 private decryption any more (CVE-2023-46809), so this
 * is the test that catches a regression back to `crypto.privateDecrypt`.
 */
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import forge from "node-forge";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "icici-crypto-"));

/** Self-signed X.509 for `keyPair`, since keyManager parses certs not bare keys. */
function writeCert(file, keyPair) {
  const cert = forge.pki.createCertificate();
  cert.publicKey = keyPair.publicKey;
  cert.serialNumber = "01";
  cert.validity.notBefore = new Date(Date.now() - 86400000);
  cert.validity.notAfter = new Date(Date.now() + 86400000);
  const attrs = [{ name: "commonName", value: "test" }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.sign(keyPair.privateKey);
  fs.writeFileSync(file, forge.pki.certificateToPem(cert));
  return cert;
}

// 2048 keeps the suite fast; the scheme is identical at the bank's 4096.
const ours = forge.pki.rsa.generateKeyPair(2048);
const bank = forge.pki.rsa.generateKeyPair(2048);

const privPath = path.join(dir, "private.key");
const ourCertPath = path.join(dir, "public.crt");
const bankCertPath = path.join(dir, "icici.crt");

fs.writeFileSync(privPath, forge.pki.privateKeyToPem(ours.privateKey));
writeCert(ourCertPath, ours);
writeCert(bankCertPath, bank);

process.env.ICICI_CRYPTO_MODE = "CIB_SV";
process.env.ICICI_PRIVATE_KEY_PATH = privPath;
process.env.ICICI_PUBLIC_CERT_PATH = ourCertPath;
process.env.ICICI_BANK_PUBLIC_CERT_PATH = bankCertPath;

const { encryptPayload, decryptPayload, isCibSvCryptoMode } = await import(
  "../modules/banking/crypto/rsaEncryption.js"
);

/**
 * Stand in for ICICI: encrypt a reply to our public key the way the bank does.
 * Observed on the sandbox, the reply puts the IV in the clear ahead of the
 * ciphertext — the mirror of our requests, which hide it in the first
 * plaintext block. Both shapes survive "treat the leading 16 bytes as the IV,
 * decrypt the lot, drop the first block", which is the bank's stated recipe.
 */
function bankEncryptsToUs(obj) {
  const aesKey = Buffer.from("1234567890123456", "utf8");
  const iv = Buffer.from("cLAB0mxruD8xRaR5", "utf8");
  const cipher = crypto.createCipheriv("aes-128-cbc", aesKey, iv);
  const body = Buffer.concat([
    cipher.update(Buffer.from(JSON.stringify(obj), "utf8")),
    cipher.final(),
  ]);
  const encryptedKey = crypto.publicEncrypt(
    {
      key: crypto.createPublicKey(forge.pki.publicKeyToPem(ours.publicKey)),
      padding: crypto.constants.RSA_PKCS1_PADDING,
    },
    aesKey
  );
  return {
    encryptedKey: encryptedKey.toString("base64"),
    encryptedData: Buffer.concat([iv, body]).toString("base64"),
  };
}

test("CIB_SV mode is selected from the environment", () => {
  assert.equal(isCibSvCryptoMode(), true);
});

test("a bank response encrypted to our public key decrypts", () => {
  const payload = { Response: "SUCCESS", Status: "Registered", Record: [{ AMOUNT: "1500.00" }] };
  assert.deepEqual(decryptPayload(bankEncryptsToUs(payload)), payload);
});

test("a large response decrypts (the sandbox statement is ~400KB)", () => {
  const payload = { Record: Array.from({ length: 4000 }, (_, i) => ({ TXNID: `T${i}`, AMOUNT: "10.00" })) };
  const out = decryptPayload(bankEncryptsToUs(payload));
  assert.equal(out.Record.length, 4000);
  assert.equal(out.Record[3999].TXNID, "T3999");
});

test("a response encrypted to someone else's key is rejected, not silently wrong", () => {
  const aesKey = Buffer.from("1234567890123456", "utf8");
  const wrong = crypto.publicEncrypt(
    {
      key: crypto.createPublicKey(forge.pki.publicKeyToPem(bank.publicKey)),
      padding: crypto.constants.RSA_PKCS1_PADDING,
    },
    aesKey
  );
  const envelope = bankEncryptsToUs({ ok: true });
  envelope.encryptedKey = wrong.toString("base64");
  assert.throws(
    () => decryptPayload(envelope),
    (err) => {
      assert.equal(err.code, "ICICI_DECRYPT_KEY_MISMATCH");
      assert.match(err.message, /different public key/);
      return true;
    }
  );
});

test("an envelope missing its parts is flagged as such", () => {
  assert.throws(() => decryptPayload({ encryptedKey: "x" }), (err) => err.code === "ICICI_DECRYPT_INVALID");
});

test("requests carry the CIB_SV envelope shape the bank documents", () => {
  const env = encryptPayload({ CORPID: "TXBCORP1" }, { service: "" });
  assert.equal(env.oaepHashingAlgorithm, "NONE");
  assert.equal(env.iv, "");
  assert.equal(env.service, "");
  assert.ok(env.requestId);
  assert.ok(env.encryptedKey && env.encryptedData);
});

test("the AES key the bank must recover is 16 ASCII digits", () => {
  const env = encryptPayload({ CORPID: "TXBCORP1" }, { service: "" });
  const aesKey = crypto.privateDecrypt(
    {
      key: crypto.createPrivateKey(forge.pki.privateKeyToPem(bank.privateKey)),
      padding: crypto.constants.RSA_PKCS1_PADDING,
    },
    Buffer.from(env.encryptedKey, "base64")
  );
  assert.equal(aesKey.length, 16);
  assert.match(aesKey.toString("utf8"), /^\d{16}$/);
});

test("a request survives the bank's own documented decryption recipe", () => {
  const payload = { CORPID: "TXBCORP1", USERID: "USER1", ACCOUNTNO: "010205001809" };
  const env = encryptPayload(payload, { service: "" });

  const aesKey = crypto.privateDecrypt(
    {
      key: crypto.createPrivateKey(forge.pki.privateKeyToPem(bank.privateKey)),
      padding: crypto.constants.RSA_PKCS1_PADDING,
    },
    Buffer.from(env.encryptedKey, "base64")
  );

  // The bank's recipe verbatim: leading 16 bytes as the IV, decrypt the whole
  // blob, discard the first block. The discarded block is garbage here because
  // our IV is not sent in the clear, which is exactly why it is discarded.
  const raw = Buffer.from(env.encryptedData, "base64");
  const decipher = crypto.createDecipheriv("aes-128-cbc", aesKey, raw.subarray(0, 16));
  const plain = Buffer.concat([decipher.update(raw), decipher.final()]);

  assert.deepEqual(JSON.parse(plain.subarray(16).toString("utf8")), payload);
});

const { buildIdentity } = await import("../modules/banking/services/iciciHttpClient.js");

const CFG = {
  corpId: "TXBCORP1",
  userId: "USER1",
  aggregatorId: "TXBCIBTEST001",
  aggregatorName: "CIBTESTING",
  urn: "TESTING123",
};

test("statement, balance and inquiry calls omit AGGRNAME", () => {
  // The sandbox answers these with response 8017 "Invalid request" if AGGRNAME
  // is present, which is what kept the statement sync from ever returning data.
  for (const endpoint of ["/AccountStatement", "/BalanceInquiry", "/TransactionInquiry"]) {
    const identity = buildIdentity(endpoint, CFG);
    assert.equal("AGGRNAME" in identity, false, `${endpoint} should not send AGGRNAME`);
    assert.deepEqual(identity, {
      CORPID: "TXBCORP1",
      USERID: "USER1",
      AGGRID: "TXBCIBTEST001",
      URN: "TESTING123",
    });
  }
});

test("registration and payment calls still send AGGRNAME", () => {
  for (const endpoint of ["/Registration", "/RegistrationStatus", "/Transaction"]) {
    assert.equal(buildIdentity(endpoint, CFG).AGGRNAME, "CIBTESTING", `${endpoint} needs AGGRNAME`);
  }
});

test("the legacy non-CIB_SV scheme keeps its camelCase identity", () => {
  process.env.ICICI_CRYPTO_MODE = "OAEP";
  try {
    assert.deepEqual(buildIdentity("/AccountStatement", CFG), {
      corpId: "TXBCORP1",
      userId: "USER1",
      aggregatorId: "TXBCIBTEST001",
    });
  } finally {
    process.env.ICICI_CRYPTO_MODE = "CIB_SV";
  }
});

test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

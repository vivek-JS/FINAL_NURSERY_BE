/**
 * TEMPORARY — is the bank encrypting the response key to OUR public key?
 * Raw-RSA the encryptedKey with our private key and inspect the padding.
 * Valid PKCS1 v1.5 looks like 00 02 <nonzero filler> 00 <payload>.
 * Delete after use.
 */
import axios from "axios";
import crypto from "crypto";
import fs from "fs";

process.env.ICICI_CRYPTO_MODE = "CIB_SV";
process.env.ICICI_PRIVATE_KEY_PATH = "./keys/private.key";
process.env.ICICI_PUBLIC_CERT_PATH = "./keys/public.crt";
process.env.ICICI_BANK_PUBLIC_CERT_PATH = "./keys/icici_public.crt";

const { encryptPayload } = await import("../modules/banking/crypto/rsaEncryption.js");

const res = await axios.post(
  "https://apibankingonesandbox.icici.bank.in/api/Corporate/CIB_SV/v1/RegistrationStatus",
  encryptPayload(
    {
      CORPID: "TXBCORP1",
      USERID: "USER1",
      AGGRID: "TXBCIBTEST001",
      URN: "TESTING123",
      AGGRNAME: "CIBTESTING",
    },
    { service: "" }
  ),
  {
    headers: { "Content-Type": "application/json", Accept: "*/*", APIKEY: "AHCMPPM9YGkQEmOFqswFe2DlaMB4OsVu" },
    timeout: 30000,
    validateStatus: () => true,
  }
);

const encKey = Buffer.from(res.data.encryptedKey, "base64");
console.log("encryptedKey bytes:", encKey.length);

const priv = crypto.createPrivateKey(fs.readFileSync("./keys/private.key"));
console.log("our key size (bytes):", Math.ceil(priv.asymmetricKeyDetails.modulusLength / 8));

// Raw RSA: no padding removal, so we can look at the padding ourselves.
const raw = crypto.privateDecrypt({ key: priv, padding: crypto.constants.RSA_NO_PADDING }, encKey);
console.log("first 8 bytes:", [...raw.subarray(0, 8)].map((b) => b.toString(16).padStart(2, "0")).join(" "));

const looksPkcs1 = raw[0] === 0x00 && raw[1] === 0x02;
console.log(looksPkcs1 ? "VALID PKCS1 → encrypted to OUR key" : "NOT PKCS1 → encrypted to a DIFFERENT key");

if (looksPkcs1) {
  const sep = raw.indexOf(0x00, 2);
  const payload = raw.subarray(sep + 1);
  console.log("recovered payload:", payload.length, "bytes →", JSON.stringify(payload.toString("utf8")));
}

// Also show the plaintext IV prefix the bank puts on encryptedData.
const data = Buffer.from(res.data.encryptedData, "base64");
console.log("encryptedData first 16 bytes as ascii:", JSON.stringify(data.subarray(0, 16).toString("utf8")));

/** TEMPORARY — dump the sandbox's raw reply so we can see what it encrypts to. Delete after use. */
import axios from "axios";

process.env.ICICI_CRYPTO_MODE = "CIB_SV";
process.env.ICICI_PRIVATE_KEY_PATH = "./keys/private.key";
process.env.ICICI_PUBLIC_CERT_PATH = "./keys/public.crt";
process.env.ICICI_BANK_PUBLIC_CERT_PATH = "./keys/icici_public.crt";

const { encryptPayload } = await import("../modules/banking/crypto/rsaEncryption.js");

const BASE = "https://apibankingonesandbox.icici.bank.in/api/Corporate/CIB_SV/v1";
const KEY = "AHCMPPM9YGkQEmOFqswFe2DlaMB4OsVu";
const ID = { CORPID: "TXBCORP1", USERID: "USER1", AGGRID: "TXBCIBTEST001", URN: "TESTING123" };

async function raw(label, path, payload) {
  const body = encryptPayload(payload, { service: "" });
  const res = await axios.post(`${BASE}${path}`, body, {
    headers: { "Content-Type": "application/json", Accept: "*/*", APIKEY: KEY },
    timeout: 30000,
    validateStatus: () => true,
  });
  console.log(`\n=== ${label} (HTTP ${res.status}) ===`);
  const d = res.data;
  if (typeof d === "object") {
    for (const [k, v] of Object.entries(d)) {
      const s = String(v);
      console.log(`  ${k}: ${s.length > 120 ? s.slice(0, 120) + `… (${s.length} chars)` : s}`);
    }
    if (d.encryptedKey) {
      console.log(`  -> encryptedKey decodes to ${Buffer.from(d.encryptedKey, "base64").length} bytes`);
    }
    if (d.encryptedData) {
      console.log(`  -> encryptedData decodes to ${Buffer.from(d.encryptedData, "base64").length} bytes`);
    }
  } else {
    console.log("  ", String(d).slice(0, 400));
  }
}

await raw("RegistrationStatus", "/RegistrationStatus", { ...ID, AGGRNAME: "CIBTESTING" });
await raw("AccountStatement", "/AccountStatement", {
  ...ID,
  ACCOUNTNO: "010205001809",
  FROMDATE: "01-01-2024",
  TODATE: "10-02-2024",
});

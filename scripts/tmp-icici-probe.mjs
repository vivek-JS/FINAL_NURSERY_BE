/**
 * TEMPORARY — live probe of the ICICI CIB_SV sandbox. Delete after use.
 * Talks to the bank only; touches no database.
 */
const UAT = {
  ICICI_CRYPTO_MODE: "CIB_SV",
  ICICI_CORPORATE_ENV: "UAT",
  ICICI_CORPORATE_BASE_URL: "https://apibankingonesandbox.icici.bank.in",
  ICICI_CORPORATE_API_PREFIX: "/api/Corporate/CIB_SV/v1",
  ICICI_CORPORATE_ID: "TXBCORP1",
  ICICI_CORPORATE_USER_ID: "USER1",
  ICICI_AGGREGATOR_ID: "TXBCIBTEST001",
  ICICI_AGGRNAME: "CIBTESTING",
  ICICI_URN: "TESTING123",
  ICICI_ACCOUNT_ID: "010205001809",
  ICICI_CORPORATE_API_KEY: "AHCMPPM9YGkQEmOFqswFe2DlaMB4OsVu",
  ICICI_PRIVATE_KEY_PATH: "./keys/private.key",
  ICICI_PUBLIC_CERT_PATH: "./keys/public.crt",
  ICICI_BANK_PUBLIC_CERT_PATH: "./keys/icici_public.crt",
  ICICI_CORPORATE_USE_STUB: "false",
  ICICI_CORPORATE_RETRY_ATTEMPTS: "1",
  ICICI_CORPORATE_TIMEOUT_MS: "30000",
  BANKING_LOG_LEVEL: "debug",
};
Object.assign(process.env, UAT);

const { iciciCorporateRequest } = await import("../modules/banking/services/iciciHttpClient.js");

async function call(label, endpointPath, payload) {
  console.log(`\n=== ${label} → ${endpointPath} ===`);
  try {
    const data = await iciciCorporateRequest({ endpointPath, payload });
    console.log("RESPONSE:", JSON.stringify(data, null, 2).slice(0, 2500));
    return data;
  } catch (e) {
    console.log("ERROR:", e.message, "| code:", e.code);
    if (e.response?.data) {
      console.log("BODY:", JSON.stringify(e.response.data, null, 2).slice(0, 1500));
    }
    return null;
  }
}

await call("Registration status", "/RegistrationStatus", {});
await call("Account statement", "/AccountStatement", {
  ACCOUNTNO: "010205001809",
  FROMDATE: "01-01-2024",
  TODATE: "10-02-2024",
});

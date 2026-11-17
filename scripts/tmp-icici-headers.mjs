/** TEMPORARY — find which header shape the CIB_SV sandbox accepts. Delete after use. */
import axios from "axios";

const URL = "https://apibankingonesandbox.icici.bank.in/api/Corporate/CIB_SV/v1/RegistrationStatus";
const KEY = "AHCMPPM9YGkQEmOFqswFe2DlaMB4OsVu";

const BODY = {
  requestId: "probe-1",
  service: "",
  encryptedKey: "x",
  encryptedData: "x",
  oaepHashingAlgorithm: "NONE",
  iv: "",
  clientInfo: "",
  optionalParam: "",
};

const variants = [
  ["apikey + accept json", { "Content-Type": "application/json", Accept: "application/json", apikey: KEY }],
  ["APIKEY + accept */*", { "Content-Type": "application/json", Accept: "*/*", APIKEY: KEY }],
  ["apikey + accept */*", { "Content-Type": "application/json", Accept: "*/*", apikey: KEY }],
  ["x-api-key + accept */*", { "Content-Type": "application/json", Accept: "*/*", "x-api-key": KEY }],
  ["APIKEY only", { "Content-Type": "application/json", APIKEY: KEY }],
  ["no key (control)", { "Content-Type": "application/json", Accept: "*/*" }],
];

for (const [label, headers] of variants) {
  try {
    const res = await axios.post(URL, BODY, { headers, timeout: 25000, validateStatus: () => true });
    const body = typeof res.data === "object" ? JSON.stringify(res.data) : String(res.data).slice(0, 200);
    console.log(`${String(res.status).padEnd(4)} ${label.padEnd(26)} ${body.slice(0, 180)}`);
  } catch (e) {
    console.log(`ERR  ${label.padEnd(26)} ${e.message}`);
  }
}

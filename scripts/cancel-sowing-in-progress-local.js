/**
 * Cancel all pending / issued sowing requests (local).
 *
 * Usage:
 *   node scripts/cancel-sowing-in-progress-local.js
 *   node scripts/cancel-sowing-in-progress-local.js --plant=69cb7cbbb6eb3413378d0253
 */
import dotenv from "dotenv";
import mongoose from "mongoose";
import { fileURLToPath } from "url";
import path from "path";
import SowingRequest from "../models/sowingRequest.model.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });

const API_BASE_URL = process.env.API_BASE_URL || "http://localhost:8000";
const AUTH_TOKEN =
  process.env.SEED_AUTH_TOKEN ||
  process.env.SUPER_ADMIN_TOKEN ||
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJfaWQiOiI2ODY5ZmYwNzllNTJlZmU2MTg0YWVjM2EiLCJwaG9uZU51bWJlciI6NzU4ODY4NjQ1Miwicm9sZSI6IlNVUEVSX0FETUlOIiwiam9iVGl0bGUiOiJTVVBFUl9BRE1JTiIsIm5hbWUiOiJTdXBlciBBZG1pbiIsInR5cGUiOiJhY2Nlc3MiLCJpYXQiOjE3ODYwODk3ODMsImV4cCI6MTc4NjE3NjE4MywiYXVkIjoibnVyc2VyeS11c2VycyIsImlzcyI6Im51cnNlcnktYXBwIn0.6_ouQJHB7gHsPsm_x8Cf_mlsj099w-m1koGcL-ivufI";

const plantFilter = (() => {
  const hit = process.argv.find((a) => a.startsWith("--plant="));
  return hit ? hit.slice("--plant=".length) : null;
})();

const REASON = "Local cleanup — cancel sowing in progress";

async function cancelViaApi(request) {
  const id = String(request._id);
  const issued = request.status === "issued" || request.status === "processing";
  const pathSuffix = issued
    ? `/api/v1/sowing/request/${id}/cancel-and-revert`
    : `/api/v1/sowing/request/${id}/cancel`;

  const res = await fetch(`${API_BASE_URL}${pathSuffix}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${AUTH_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ reason: REASON }),
  });

  const body = await res.json().catch(() => ({}));
  if (!res.ok && !/already cancelled/i.test(String(body?.message || ""))) {
    throw new Error(body?.message || body?.error || `HTTP ${res.status}`);
  }
  return body?.message || "cancelled";
}

await mongoose.connect(process.env.MONGO_URL || process.env.MONGODB_URI);

const query = {
  status: { $in: ["pending", "processing", "issued"] },
  sowingCompleted: { $ne: true },
};
if (plantFilter) query.plantId = plantFilter;

const requests = await SowingRequest.find(query)
  .select("_id requestNumber status plantId subtypeId sowingInProgress outwardId")
  .sort({ requestNumber: 1 })
  .lean();

console.log(`Found ${requests.length} active sowing request(s)${plantFilter ? ` for plant ${plantFilter}` : ""}`);

let ok = 0;
let failed = 0;

for (const req of requests) {
  const label = `${req.requestNumber} (${req.status})`;
  try {
    const msg = await cancelViaApi(req);
    console.log(`✓ ${label} → ${msg}`);
    ok += 1;
  } catch (err) {
    console.error(`✗ ${label} → ${err.message}`);
    failed += 1;
  }
}

await mongoose.disconnect();
console.log(`Done. cancelled=${ok}, failed=${failed}`);
if (failed > 0) process.exit(1);

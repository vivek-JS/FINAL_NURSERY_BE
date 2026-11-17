/**
 * Add leftover excess on already-seeded Ram Tarbuja order sow batches.
 *
 *   node scripts/add-ram-tarbuja-order-sow-excess.js --prod
 *   node scripts/add-ram-tarbuja-order-sow-excess.js --local --execute
 */
import dotenv from "dotenv";
import mongoose from "mongoose";
import path from "path";
import { fileURLToPath } from "url";
import {
  BATCH_ID,
  ensureOrderSowExcess,
} from "./lib/ramTarbujaDispatchScenarioHelpers.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });

const EXECUTE = process.argv.includes("--execute");
const USE_LOCAL = process.argv.includes("--local");
const USE_PROD = process.argv.includes("--prod");

/** caseKey → target excess plants on that sow request */
const TARGETS = [
  { caseKey: "ABLE_EXACT_2026-10-17", excess: 500, covered: 1000 },
  { caseKey: "ABLE_EXACT_2026-10-19", excess: 800, covered: 1000 },
  { caseKey: "ABLE_EXACT_2026-10-21", excess: 400, covered: 1200 },
  { caseKey: "READY_STATUS_2026-10-19", excess: 300, covered: 1000 },
  { caseKey: "MULTI_SOW_COVER", excess: 500, covered: 3000 },
];

function resolveUrl() {
  if (USE_LOCAL === USE_PROD) throw new Error("Pass exactly one of --local or --prod");
  if (USE_PROD) {
    if (!process.env.PROD_MONGO_URL) throw new Error("PROD_MONGO_URL missing");
    return { label: "prod", url: process.env.PROD_MONGO_URL };
  }
  const url =
    process.env.MONGO_URL || process.env.STAGE_MONGO_URL || process.env.MONGODB_URI;
  if (!url) throw new Error("MONGO_URL missing");
  return { label: "local", url };
}

async function main() {
  const env = resolveUrl();
  await mongoose.connect(env.url, { serverSelectionTimeoutMS: 20000 });
  console.log(`${EXECUTE ? "EXECUTE" : "DRY RUN"} · ${env.label} · add order-sow excess`);

  for (const t of TARGETS) {
    const notesTag = `${BATCH_ID}:SOW:${t.caseKey}:`;
    const req = await mongoose.connection.db.collection("sowingrequests").findOne(
      { notes: { $regex: notesTag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") } },
      { projection: { requestNumber: 1, sowedQuantity: 1, notes: 1 } }
    );
    if (!req) {
      console.log(`MISSING ${t.caseKey}`);
      continue;
    }
    console.log(
      `${t.caseKey} ${req.requestNumber} currentSowed=${req.sowedQuantity} → covered=${t.covered} excess=${t.excess}`
    );
    if (!EXECUTE) continue;
    const result = await ensureOrderSowExcess(req.requestNumber, t.excess, t.covered);
    console.log(JSON.stringify(result));
  }

  if (!EXECUTE) console.log("\nPass --execute to write.");
}

main()
  .catch((e) => {
    console.error(e.message || e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect().catch(() => {});
  });

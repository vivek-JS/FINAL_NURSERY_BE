/**
 * One-shot money ledger historical backfill.
 * Usage (on ERP host from /var/www/FINAL_NURSERY_BE):
 *   NODE_ENV=production node scripts/runMoneyLedgerBackfill.mjs
 *   NODE_ENV=production node scripts/runMoneyLedgerBackfill.mjs --dry-run
 *   NODE_ENV=production node scripts/runMoneyLedgerBackfill.mjs --limit=100
 */
import "dotenv/config";
import mongoose from "mongoose";
import { runMoneyLedgerBackfill } from "../services/moneyLedger/backfill.js";

function resolveMongoUrl() {
  const isProd = process.env.NODE_ENV === "production";
  if (isProd) {
    return (
      process.env.PROD_MONGO_URL ||
      process.env.MONGO_URL ||
      process.env.MONGODB_URI ||
      ""
    );
  }
  return (
    process.env.MONGO_URL ||
    process.env.STAGE_MONGO_URL ||
    process.env.MONGODB_URI ||
    ""
  );
}

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const limitArg = args.find((a) => a.startsWith("--limit="));
const limit = limitArg ? Number(limitArg.split("=")[1]) || 0 : 0;

const uri = resolveMongoUrl();
if (!uri) {
  console.error("No Mongo URI (PROD_MONGO_URL / MONGO_URL)");
  process.exit(1);
}

console.log(
  `[moneyLedgerBackfill] connecting… dryRun=${dryRun} limit=${limit || "all"} NODE_ENV=${
    process.env.NODE_ENV || ""
  }`
);

await mongoose.connect(uri, {
  serverSelectionTimeoutMS: 15000,
  socketTimeoutMS: 120000,
});

try {
  const result = await runMoneyLedgerBackfill({ dryRun, limit });
  console.log(JSON.stringify(result, null, 2));
  if (result.stats?.errors?.length) {
    console.error(`[moneyLedgerBackfill] ${result.stats.errors.length} errors (see stats.errors)`);
  }
} catch (e) {
  console.error("[moneyLedgerBackfill] FAILED:", e);
  process.exitCode = 1;
} finally {
  await mongoose.disconnect();
}

/**
 * Manual run: past-due slot rollover.
 * Usage:
 *   node scripts/run-past-due-slot-rollover.js
 *   node scripts/run-past-due-slot-rollover.js --dry-run
 *   node scripts/run-past-due-slot-rollover.js --dry-run --stage
 *   node scripts/run-past-due-slot-rollover.js --dry-run --prod
 *   node scripts/run-past-due-slot-rollover.js --as-of=2026-06-08
 */

import mongoose from "mongoose";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "..", ".env") });

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const useProd = args.includes("--prod");
const useStage = args.includes("--stage") && !useProd;
const asOfArg = args.find((a) => a.startsWith("--as-of="));
const asOfDate = asOfArg ? asOfArg.split("=")[1] : undefined;

if (useProd && useStage) {
  console.error("Use only one of --prod or --stage");
  process.exit(1);
}

const mongoUrl = useProd
  ? process.env.PROD_MONGO_URL
  : useStage
    ? process.env.STAGE_MONGO_URL
    : process.env.MONGO_URL ||
      process.env.STAGE_MONGO_URL ||
      process.env.MONGODB_URI;

if (!mongoUrl) {
  console.error(
    useProd
      ? "Set PROD_MONGO_URL in FINAL_NURSERY_BE/.env"
      : useStage
        ? "Set STAGE_MONGO_URL in .env (or pass without --stage for MONGO_URL)"
        : "Set MONGO_URL, STAGE_MONGO_URL, or MONGODB_URI in .env"
  );
  process.exit(1);
}

const dbLabel = useProd ? "PROD" : useStage ? "STAGE" : "default";

const MONGO_CONNECT_OPTS = {
  serverSelectionTimeoutMS: 60_000,
  connectTimeoutMS: 60_000,
  socketTimeoutMS: 300_000,
  maxPoolSize: 10,
};

async function main() {
  const t0 = Date.now();
  console.log(`[past-due-rollover] connecting to ${dbLabel} DB, dryRun=${dryRun}...`);
  await mongoose.connect(mongoUrl, MONGO_CONNECT_OPTS);
  console.log(`[past-due-rollover] connected (${Date.now() - t0}ms)`);
  const { runPastDueSlotRollover } = await import(
    "../services/pastDueSlotRollover.service.js"
  );
  const summary = await runPastDueSlotRollover({
    asOfDate: asOfDate ? new Date(asOfDate) : undefined,
    dryRun,
    onProgress: (msg) => console.log(msg),
  });
  const toMoveRows =
    summary.breakdown?.toMoveByStatus || summary.breakdown?.byOrderStatus || [];
  if (toMoveRows.length) {
    console.log("\nBy order status (to move):");
    for (const row of toMoveRows) {
      console.log(`  ${row.status}: ${row.orders} orders, ${row.plants} plants`);
    }
  }
  console.log(JSON.stringify(summary, null, 2));
  console.log(`[past-due-rollover] total wall time: ${Date.now() - t0}ms`);
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

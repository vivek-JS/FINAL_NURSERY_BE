/**
 * Manual run: unified slot-end nightly automation.
 * Usage:
 *   node scripts/run-slot-end-nightly.js
 *   node scripts/run-slot-end-nightly.js --dry-run
 *   node scripts/run-slot-end-nightly.js --dry-run --stage
 *   node scripts/run-slot-end-nightly.js --dry-run --prod
 *   node scripts/run-slot-end-nightly.js --as-of=2026-06-08
 *   node scripts/run-slot-end-nightly.js --no-capacity --no-lagwad
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

const steps = {
  orders: !args.includes("--no-orders"),
  capacityRoll: !args.includes("--no-capacity"),
  lagwadRelocate: !args.includes("--no-lagwad"),
};

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
  console.log(
    `[slot-end-nightly] connecting to ${dbLabel} DB, dryRun=${dryRun} steps=${JSON.stringify(steps)}...`
  );
  await mongoose.connect(mongoUrl, MONGO_CONNECT_OPTS);
  console.log(`[slot-end-nightly] connected (${Date.now() - t0}ms)`);
  const { runSlotEndNightlyAutomation } = await import(
    "../services/slotEndNightlyAutomation.service.js"
  );
  const summary = await runSlotEndNightlyAutomation({
    asOfDate: asOfDate ? new Date(asOfDate) : undefined,
    dryRun,
    steps,
    onProgress: (msg) => console.log(msg),
  });
  console.log(JSON.stringify(summary, null, 2));
  console.log(`[slot-end-nightly] total wall time: ${Date.now() - t0}ms`);
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

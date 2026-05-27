/**
 * Backfill central ledger from existing sub-ledgers (same shadow handlers + idempotency keys as live).
 *
 * Usage:
 *   npm run backfill:central-ledger -- --stage
 *   npm run backfill:central-ledger -- --stage --dry-run
 *   npm run backfill:central-ledger -- --since=2025-01-01 --until=2025-12-31 --stage
 *
 * DB (default with --stage): STAGE_MONGO_URL only — never PROD_MONGO_URL.
 * Without --stage: STAGE_MONGO_URL, then MONGO_URL / MONGODB_URI / DATABASE (not PROD unless --allow-prod).
 */
import dotenv from "dotenv";
import mongoose from "mongoose";
import { seedChartOfAccounts } from "../modules/finance/coa/seedChartOfAccounts.js";
import {
  setFinanceSerialPost,
  drainFinancePostLock,
} from "../modules/finance/posting/financePostLock.js";
import { replayAllSubLedgersToCentral } from "../modules/finance/integration/replaySubLedgerToCentral.js";

function readArg(name) {
  const prefix = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : null;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function resolveMongoUri() {
  const stageOnly = hasFlag("stage");
  const allowProd = hasFlag("allow-prod");

  if (stageOnly) {
    if (!process.env.STAGE_MONGO_URL) {
      console.error("--stage requires STAGE_MONGO_URL in .env");
      process.exit(1);
    }
    console.log("Using STAGE_MONGO_URL (stage-only mode)");
    return process.env.STAGE_MONGO_URL;
  }

  const uri =
    process.env.STAGE_MONGO_URL ||
    process.env.MONGO_URL ||
    process.env.MONGODB_URI ||
    process.env.DATABASE ||
    (allowProd ? process.env.PROD_MONGO_URL : null);

  if (!uri) {
    console.error("Set STAGE_MONGO_URL, MONGO_URL, MONGODB_URI, or DATABASE");
    process.exit(1);
  }

  if (
    process.env.PROD_MONGO_URL &&
    uri === process.env.PROD_MONGO_URL &&
    !allowProd
  ) {
    console.error(
      "Refusing PROD_MONGO_URL. Use --stage for STAGE_MONGO_URL or pass --allow-prod explicitly."
    );
    process.exit(1);
  }

  if (process.env.STAGE_MONGO_URL && uri === process.env.STAGE_MONGO_URL) {
    console.log("Using STAGE_MONGO_URL");
  } else {
    console.log("Using non-prod Mongo URL from env");
  }

  return uri;
}

async function main() {
  dotenv.config();
  const uri = resolveMongoUri();

  const dryRun = hasFlag("dry-run");
  const since = readArg("since");
  const until = readArg("until");
  const sourcesArg = readArg("sources");
  const sources = sourcesArg
    ? sourcesArg.split(",").map((s) => s.trim().toLowerCase())
    : ["farmer", "agri", "dealer", "wallet", "bank"];

  await mongoose.connect(uri);
  console.log("Connected. Seeding chart of accounts (idempotent)…");
  await seedChartOfAccounts();

  console.log(
    JSON.stringify(
      { dryRun, since: since || null, until: until || null, sources, serialPost: true },
      null,
      2
    )
  );

  setFinanceSerialPost(true);
  const started = Date.now();
  try {
    const stats = await replayAllSubLedgersToCentral({
      sources,
      dryRun,
      since,
      until,
      onProgress: () => {
        if (statsLogged()) return;
      },
    });

    console.log(
      JSON.stringify(
        {
          dryRun,
          elapsedMs: Date.now() - started,
          stats,
        },
        null,
        2
      )
    );
  } finally {
    setFinanceSerialPost(false);
    await drainFinancePostLock();
    await mongoose.disconnect();
  }
}

let progressCount = 0;
function statsLogged() {
  progressCount += 1;
  if (progressCount % 5000 === 0) {
    console.log(`… processed ${progressCount} replay steps`);
    return true;
  }
  return false;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

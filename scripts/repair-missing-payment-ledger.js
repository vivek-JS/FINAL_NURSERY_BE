/**
 * One-time repair: recreate sub-ledger rows for COLLECTED payments that were added
 * through the batch / multiple-payment flow during the window where the farmer-plant
 * transition classifier treated a null previousStatus as INVALID (so no PAYMENT credit
 * row was ever written, and therefore no central-ledger entry either).
 *
 * For every order with COLLECTED payments that have NO sub-ledger row referencing the
 * payment, this re-runs the idempotent ledger helpers:
 *   - ensureFarmerPlantOrderDebit (ORDER debit, idempotent via unique index)
 *   - recordFarmerPlantLedgerPaymentTransition(order, payment, null, "COLLECTED") (CREDIT)
 *   - syncDealerLedgerForOrder (dealer receivable + booking, idempotent)
 *
 * The sub-ledger rows are the source of truth; central-ledger entries are then produced
 * either by the live shadow emit inside the helpers or by the central replay pass that
 * this script runs at the end (idempotent — existing central rows are skipped).
 *
 * Usage:
 *   node scripts/repair-missing-payment-ledger.js --stage --dry-run
 *   node scripts/repair-missing-payment-ledger.js --stage
 *   node scripts/repair-missing-payment-ledger.js --stage --skip-central
 *   node scripts/repair-missing-payment-ledger.js --allow-prod
 *
 * DB selection mirrors backfill-central-ledger-from-subledgers.js:
 *   --stage uses STAGE_MONGO_URL only; prod requires explicit --allow-prod.
 */
import dotenv from "dotenv";
import mongoose from "mongoose";

import Order from "../models/order.model.js";
import FarmerPlantOrderLedgerEntry from "../models/farmerPlantOrderLedger.model.js";
import {
  ensureFarmerPlantOrderDebit,
  recordFarmerPlantLedgerPaymentTransition,
} from "../utils/farmerPlantOrderLedgerHelper.js";
import { syncDealerLedgerForOrder } from "../utils/dealerLedgerHelper.js";
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

  if (process.env.PROD_MONGO_URL && uri === process.env.PROD_MONGO_URL && !allowProd) {
    console.error(
      "Refusing PROD_MONGO_URL. Use --stage for STAGE_MONGO_URL or pass --allow-prod explicitly."
    );
    process.exit(1);
  }

  console.log(
    process.env.STAGE_MONGO_URL && uri === process.env.STAGE_MONGO_URL
      ? "Using STAGE_MONGO_URL"
      : "Using non-prod Mongo URL from env"
  );
  return uri;
}

/** True when any sub-ledger row already references this payment (so it is not a gap). */
async function paymentAlreadyInLedger(orderId, paymentId) {
  const existing = await FarmerPlantOrderLedgerEntry.findOne({
    orderId,
    paymentId,
  })
    .select("_id")
    .lean();
  return Boolean(existing);
}

async function repairOrder(order, stats, { dryRun }) {
  const collected = (order.payment || []).filter(
    (p) => p.paymentStatus === "COLLECTED" && Number(p.paidAmount) > 0
  );
  if (!collected.length) return;

  let touchedOrder = false;

  for (const payment of collected) {
    stats.collectedScanned += 1;
    if (await paymentAlreadyInLedger(order._id, payment._id)) {
      stats.alreadyLinked += 1;
      continue;
    }

    stats.missing += 1;
    touchedOrder = true;
    if (dryRun) {
      console.log(
        `[dry-run] order ${order.orderId ?? order._id} payment ${payment._id} (₹${payment.paidAmount}) → would create CREDIT`
      );
      continue;
    }

    try {
      await ensureFarmerPlantOrderDebit(order, {});
      const row = await recordFarmerPlantLedgerPaymentTransition(
        order,
        payment,
        null,
        "COLLECTED",
        {}
      );
      if (row) {
        stats.created += 1;
      } else {
        stats.notLogged += 1;
      }
    } catch (err) {
      stats.errors += 1;
      console.error(
        `order ${order.orderId ?? order._id} payment ${payment._id} repair failed:`,
        err?.message || err
      );
    }
  }

  if (!dryRun && touchedOrder && (order.dealerOrder || order.dealer)) {
    try {
      await syncDealerLedgerForOrder(order, {});
    } catch (err) {
      console.error(
        `order ${order.orderId ?? order._id} dealer ledger sync failed:`,
        err?.message || err
      );
    }
  }
}

async function main() {
  dotenv.config();
  const uri = resolveMongoUri();
  const dryRun = hasFlag("dry-run");
  const skipCentral = hasFlag("skip-central");
  const since = readArg("since");
  const until = readArg("until");

  await mongoose.connect(uri);
  console.log("Connected. Seeding chart of accounts (idempotent)…");
  await seedChartOfAccounts();
  setFinanceSerialPost(true);

  const stats = {
    ordersScanned: 0,
    collectedScanned: 0,
    alreadyLinked: 0,
    missing: 0,
    created: 0,
    notLogged: 0,
    errors: 0,
  };

  const query = { "payment.paymentStatus": "COLLECTED" };
  if (since || until) {
    query.orderBookingDate = {};
    if (since) query.orderBookingDate.$gte = new Date(since);
    if (until) query.orderBookingDate.$lte = new Date(until);
  }

  console.log(JSON.stringify({ dryRun, skipCentral, since: since || null, until: until || null }, null, 2));

  const started = Date.now();
  try {
    const cursor = Order.find(query)
      .populate("farmer", "name village mobileNumber alternateNumber originalPhoneNumber taluka talukaName")
      .populate("plantName", "name")
      .sort({ _id: 1 })
      .cursor();

    for await (const order of cursor) {
      stats.ordersScanned += 1;
      await repairOrder(order, stats, { dryRun });
      if (stats.ordersScanned % 500 === 0) {
        console.log(`… scanned ${stats.ordersScanned} orders (created ${stats.created})`);
      }
    }

    console.log("Sub-ledger repair complete:", JSON.stringify(stats, null, 2));

    if (!dryRun && !skipCentral && stats.created > 0) {
      console.log("Replaying farmer + dealer sub-ledgers into central ledger (idempotent)…");
      const centralStats = await replayAllSubLedgersToCentral({
        sources: ["farmer", "dealer"],
        since,
        until,
      });
      console.log("Central replay complete:", JSON.stringify(centralStats, null, 2));
    } else if (!skipCentral) {
      console.log(
        "Skipping central replay (dry-run or nothing created). Run `npm run backfill:central-ledger -- --stage` if needed."
      );
    }

    console.log(JSON.stringify({ elapsedMs: Date.now() - started }, null, 2));
  } finally {
    setFinanceSerialPost(false);
    await drainFinancePostLock();
    await mongoose.disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

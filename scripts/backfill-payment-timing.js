/**
 * Backfill paymentTiming (advance | balance) on farmer order payment lines.
 *
 * Usage:
 *   node scripts/backfill-payment-timing.js
 *   node scripts/backfill-payment-timing.js --dry-run
 *   node scripts/backfill-payment-timing.js --date=2026-03-30
 *   node scripts/backfill-payment-timing.js --force
 *
 * Connection env fallback:
 *   PROD_MONGO_URL -> MONGO_URL -> MONGODB_URI -> DATABASE
 */
import dotenv from "dotenv";
import mongoose from "mongoose";
import Order from "../models/order.model.js";
import {
  getFirstDispatchAt,
  firstDispatchAtIso,
  derivePaymentTiming,
} from "../utils/paymentTiming.js";

function readArg(name) {
  const prefix = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : null;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

async function main() {
  dotenv.config();
  const uri =
    process.env.PROD_MONGO_URL ||
    process.env.MONGO_URL ||
    process.env.MONGODB_URI ||
    process.env.DATABASE;
  if (!uri) {
    console.error("Set PROD_MONGO_URL/MONGO_URL/MONGODB_URI/DATABASE");
    process.exit(1);
  }

  const dateArg = readArg("date");
  const dryRun = hasFlag("dry-run");
  const force = hasFlag("force");

  await mongoose.connect(uri);
  console.log(`Connected. Backfill paymentTiming${dryRun ? " (dry-run)" : ""}…`);

  const query = { payment: { $exists: true, $ne: [] } };
  if (dateArg) {
    const start = new Date(`${dateArg}T00:00:00.000Z`);
    const end = new Date(`${dateArg}T23:59:59.999Z`);
    if (!Number.isNaN(start.getTime()) && !Number.isNaN(end.getTime())) {
      query.createdAt = { $gte: start, $lte: end };
    }
  }

  const cursor = Order.find(query).select(
    "payment dispatchHistory statusChanges dispatchTargetDate orderId"
  );

  let ordersScanned = 0;
  let linesUpdated = 0;
  let linesSkipped = 0;
  let ordersSaved = 0;
  let errors = 0;

  for await (const lean of cursor) {
    ordersScanned += 1;
    const order = await Order.findById(lean._id);
    if (!order || !Array.isArray(order.payment) || !order.payment.length) continue;

    const iso = firstDispatchAtIso(getFirstDispatchAt(order));
    let dirty = false;

    for (const p of order.payment) {
      if (!p) continue;
      const derived = derivePaymentTiming(p, iso);
      if (derived !== "advance" && derived !== "balance") {
        linesSkipped += 1;
        continue;
      }
      if (!force && (p.paymentTiming === "advance" || p.paymentTiming === "balance")) {
        linesSkipped += 1;
        continue;
      }
      if (p.paymentTiming === derived) {
        linesSkipped += 1;
        continue;
      }
      if (!dryRun) {
        p.paymentTiming = derived;
      }
      linesUpdated += 1;
      dirty = true;
    }

    if (dirty && !dryRun) {
      try {
        await order.save();
        ordersSaved += 1;
      } catch (err) {
        errors += 1;
        console.error(`Order ${order.orderId}: ${err.message}`);
      }
    }
  }

  console.log({
    ordersScanned,
    linesUpdated,
    linesSkipped,
    ordersSaved,
    errors,
    dryRun,
    force,
  });

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

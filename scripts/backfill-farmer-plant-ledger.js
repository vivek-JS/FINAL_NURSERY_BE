/**
 * Backfill farmer plant ledger for existing orders.
 *
 * Usage:
 *   node scripts/backfill-farmer-plant-ledger.js
 *   node scripts/backfill-farmer-plant-ledger.js --date=2026-03-30
 *   node scripts/backfill-farmer-plant-ledger.js --date=2026-03-30 --dry-run
 *
 * Connection env fallback:
 *   PROD_MONGO_URL -> MONGO_URL -> MONGODB_URI -> DATABASE
 */
import dotenv from "dotenv";
import mongoose from "mongoose";
import Order from "../models/order.model.js";
import FarmerPlantOrderLedgerEntry from "../models/farmerPlantOrderLedger.model.js";
import {
  ensureFarmerPlantOrderDebit,
  recordFarmerPlantLedgerPaymentTransition,
} from "../utils/farmerPlantOrderLedgerHelper.js";

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

  await mongoose.connect(uri);
  console.log("Connected. Backfilling farmer plant ledger…");

  const query = {
    dealerOrder: false,
    farmer: { $exists: true, $ne: null },
  };
  if (dateArg) {
    const start = new Date(`${dateArg}T00:00:00.000Z`);
    const end = new Date(`${dateArg}T23:59:59.999Z`);
    if (!Number.isNaN(start.getTime()) && !Number.isNaN(end.getTime())) {
      query.createdAt = { $gte: start, $lte: end };
    }
  }

  const orders = await Order.find(query).lean();

  let orderRowsEnsured = 0;
  let paymentRows = 0;
  let missingOrderRows = 0;
  let missingPaymentRows = 0;

  for (const lean of orders) {
    const order = await Order.findById(lean._id);
    if (!order) continue;

    try {
      const hasOrderRow = await FarmerPlantOrderLedgerEntry.findOne({
        orderId: order._id,
        refType: "ORDER",
      }).lean();
      if (!hasOrderRow) {
        missingOrderRows += 1;
      }
      if (!dryRun) {
        const ensured = await ensureFarmerPlantOrderDebit(order, {});
        if (ensured) orderRowsEnsured += 1;
      }
    } catch (e) {
      console.error("ORDER debit failed", order._id, e.message);
    }

    for (const p of order.payment || []) {
      if (p.paymentStatus !== "COLLECTED") continue;
      const exists = await FarmerPlantOrderLedgerEntry.findOne({
        orderId: order._id,
        refType: "PAYMENT",
        paymentId: p._id,
      }).lean();
      if (exists) continue;
      missingPaymentRows += 1;
      if (dryRun) continue;
      try {
        const r = await recordFarmerPlantLedgerPaymentTransition(
          order,
          p,
          "PENDING",
          "COLLECTED",
          {}
        );
        if (r) paymentRows += 1;
      } catch (e) {
        if (e.code !== 11000) {
          console.error("PAYMENT failed", order._id, p._id, e.message);
        }
      }
    }
  }

  console.log(
    JSON.stringify(
      {
        dryRun,
        dateFilter: dateArg || null,
        ordersProcessed: orders.length,
        missingOrderRows,
        missingPaymentRows,
        orderRowsEnsured,
        paymentRowsAdded: paymentRows,
      },
      null,
      2
    )
  );
  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

/**
 * Remove all embedded payments on an Order (by human orderId), delete DealerLedgerEntry
 * rows for that order, and strip matching DealerWallet embedded transactions + fix balance.
 *
 * Use when cleaning duplicate/erroneous payment rows. Prefer dry run first.
 *
 *   node scripts/remove-order-payments-and-dealer-ledger.js --prod --orderId=25261626
 *   node scripts/remove-order-payments-and-dealer-ledger.js --prod --orderId=25261626 --execute
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import mongoose from "mongoose";
import Order from "../models/order.model.js";
import DealerWallet from "../models/dealerWallet.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "../.env") });

function parseArgs(argv) {
  const out = { prod: false, orderId: null, execute: false };
  for (const a of argv) {
    if (a === "--prod") out.prod = true;
    else if (a === "--execute") out.execute = true;
    else if (a.startsWith("--orderId=")) out.orderId = a.slice(10);
  }
  return out;
}

async function main() {
  const { prod, orderId: orderIdStr, execute } = parseArgs(process.argv.slice(2));
  const orderIdNum = Number(orderIdStr);
  if (!Number.isFinite(orderIdNum)) {
    console.error("Usage: ... --orderId=<number> [--prod] [--execute]");
    process.exit(1);
  }

  const uri = prod
    ? process.env.PROD_MONGO_URL
    : process.env.MONGO_URL || process.env.STAGE_MONGO_URL || process.env.MONGODB_URI;
  if (!uri) {
    console.error("Missing Mongo URI");
    process.exit(1);
  }

  await mongoose.connect(uri, { serverSelectionTimeoutMS: 20000 });

  const order = await Order.findOne({ orderId: orderIdNum }).lean();
  if (!order) {
    console.error(`No order with orderId=${orderIdNum}`);
    await mongoose.disconnect();
    process.exit(1);
  }

  const oid = order._id;
  const payments = order.payment || [];
  const dealerId = order.dealer ? String(order.dealer) : null;

  let wallet = dealerId ? await DealerWallet.findOne({ dealer: dealerId }).lean() : null;
  const txs = wallet?.transactions || [];
  const txsForOrder = txs.filter(
    (t) =>
      String(t.relatedOrder || "") === String(oid) ||
      (t.description && String(t.description).includes(String(oid)))
  );

  const ledgerCol = mongoose.connection.db.collection("dealerledgerentries");
  const ledgerRows = await ledgerCol.find({ orderId: oid }).toArray();

  console.log("Order:", oid.toString(), "orderId", order.orderId, "dealerOrder", order.dealerOrder);
  console.log("Payments to clear:", payments.length);
  console.log("Dealer ledger rows:", ledgerRows.length);
  console.log("Wallet txs (all):", txs.length);
  console.log("Wallet txs linked to this order (filter):", txsForOrder.length);

  if (!execute) {
    console.log("\nDry run. --execute to: $set payment=[], delete ledger by orderId, remove wallet txs for order, set availableAmount from restored baseline.");
    await mongoose.disconnect();
    process.exit(0);
  }

  // Baseline balance before any wallet movement for this order: first chronological tx for this order's balanceBefore, or current availableAmount if no tx match
  let newAvailable = wallet ? Number(wallet.availableAmount) : 0;
  if (txsForOrder.length > 0) {
    const sorted = [...txsForOrder].sort(
      (a, b) => new Date(a.createdAt || 0) - new Date(b.createdAt || 0)
    );
    newAvailable = Number(sorted[0].balanceBefore);
  }

  const pullIds = txsForOrder.map((t) => t._id).filter(Boolean);
  if (pullIds.length === 0 && txs.length > 0) {
    console.warn("No relatedOrder match; pulling ledger-only and clearing payments. Wallet not auto-cleaned.");
  }

  await Order.updateOne({ _id: oid }, { $set: { payment: [] } });
  const delLed = await ledgerCol.deleteMany({ orderId: oid });
  console.log("Order payments cleared. Ledger deleted:", delLed.deletedCount);

  if (dealerId && wallet && pullIds.length > 0) {
    await DealerWallet.updateOne(
      { _id: wallet._id },
      {
        $pull: { transactions: { _id: { $in: pullIds } } },
        $set: { availableAmount: newAvailable },
      }
    );
    console.log("Wallet: pulled", pullIds.length, "txs, availableAmount ->", newAvailable);
  } else if (dealerId && wallet && txsForOrder.length === 0) {
    console.log("Wallet: no tx pull (no relatedOrder match). Verify manually.");
  }

  await mongoose.disconnect();
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

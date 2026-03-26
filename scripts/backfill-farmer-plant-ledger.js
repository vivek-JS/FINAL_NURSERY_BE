/**
 * Optional backfill: create ORDER debits and PAYMENT credits for existing farmer plant orders
 * that predate the farmer plant ledger.
 *
 * Usage:
 *   node scripts/backfill-farmer-plant-ledger.js
 * Requires MONGODB_URI or DATABASE in env (same as app).
 */
import mongoose from "mongoose";
import Order from "../models/order.model.js";
import FarmerPlantOrderLedgerEntry from "../models/farmerPlantOrderLedger.model.js";
import {
  ensureFarmerPlantOrderDebit,
  recordFarmerPlantLedgerPaymentTransition,
} from "../utils/farmerPlantOrderLedgerHelper.js";

async function main() {
  const uri = process.env.MONGODB_URI || process.env.DATABASE;
  if (!uri) {
    console.error("Set MONGODB_URI or DATABASE");
    process.exit(1);
  }
  await mongoose.connect(uri);
  console.log("Connected. Backfilling farmer plant ledger…");

  const orders = await Order.find({
    dealerOrder: false,
    farmer: { $exists: true, $ne: null },
  }).lean();

  let paymentRows = 0;

  for (const lean of orders) {
    const order = await Order.findById(lean._id);
    if (!order) continue;

    try {
      await ensureFarmerPlantOrderDebit(order, {});
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
      try {
        const r = await recordFarmerPlantLedgerPaymentTransition(
          order,
          p,
          null,
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

  console.log(`Done. Orders processed: ${orders.length}, ORDER rows ensured, PAYMENT rows added: ${paymentRows}`);
  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

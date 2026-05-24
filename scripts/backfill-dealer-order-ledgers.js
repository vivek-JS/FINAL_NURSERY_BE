/**
 * Backfill farmer-plant ledger + dealer ORDER_BOOKING audit for dealerOrder=true.
 *
 * Usage:
 *   node scripts/backfill-dealer-order-ledgers.js [--dry-run] [--limit=500]
 */
import mongoose from "mongoose";
import dotenv from "dotenv";
import Order from "../models/order.model.js";
import DealerLedgerEntry from "../models/dealerLedgerEntry.model.js";
import {
  ensureFarmerPlantOrderDebit,
  recordFarmerPlantLedgerPaymentTransition,
  shouldLogFarmerPlantLedger,
} from "../utils/farmerPlantOrderLedgerHelper.js";
import {
  ensureDealerOrderBookingAudit,
  ensureDealerOrderReceivablePaymentCredit,
} from "../utils/dealerLedgerHelper.js";

dotenv.config();

const dryRun = process.argv.includes("--dry-run");
const limitArg = process.argv.find((a) => a.startsWith("--limit="));
const limit = limitArg ? parseInt(limitArg.split("=")[1], 10) : 0;

async function main() {
  await mongoose.connect(process.env.MONGO_URI || process.env.MONGODB_URI);

  let q = Order.find({ dealerOrder: true }).sort({ createdAt: 1 });
  if (limit > 0) q = q.limit(limit);
  const orders = await q.lean();

  let farmerDebit = 0;
  let farmerPayments = 0;
  let dealerAudit = 0;
  let skipped = 0;

  for (const order of orders) {
    if (!shouldLogFarmerPlantLedger(order)) {
      skipped += 1;
      continue;
    }

    if (dryRun) {
      console.log(`[dry-run] would backfill order ${order.orderId} (${order._id})`);
      continue;
    }

    const session = await mongoose.startSession();
    try {
      session.startTransaction();
      const debit = await ensureFarmerPlantOrderDebit(order, { session });
      if (debit) farmerDebit += 1;

      for (const payment of order.payment || []) {
        const row = await recordFarmerPlantLedgerPaymentTransition(
          order,
          payment,
          null,
          payment.paymentStatus,
          { session }
        );
        if (row) farmerPayments += 1;
        if (payment.paymentStatus === "COLLECTED") {
          const recv = await ensureDealerOrderReceivablePaymentCredit(order, payment, {
            session,
          });
          if (recv) farmerPayments += 1;
        }
      }

      await DealerLedgerEntry.deleteMany(
        { orderId: order._id, refType: "ORDER_BOOKING", debit: 0 },
        { session }
      );

      const audit = await ensureDealerOrderBookingAudit(order, { session });
      if (audit) dealerAudit += 1;

      await session.commitTransaction();
    } catch (e) {
      await session.abortTransaction();
      console.error(`Order ${order.orderId}:`, e.message);
    } finally {
      session.endSession();
    }
  }

  console.log(
    JSON.stringify(
      {
        dryRun,
        total: orders.length,
        skippedNoIdentity: skipped,
        farmerDebitCreated: farmerDebit,
        farmerPaymentRows: farmerPayments,
        dealerBookingAudit: dealerAudit,
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

/**
 * Backfill dealer ORDER_BOOKING + payment credits for orders funded by a dealer.
 *
 * Usage:
 *   node scripts/backfill-dealer-order-ledgers.js [--dry-run] [--limit=500] [--orderId=25262304]
 */
import mongoose from "mongoose";
import dotenv from "dotenv";
import Order from "../models/order.model.js";
import DealerLedgerEntry from "../models/dealerLedgerEntry.model.js";
import { repairDealerLedgerForDealer } from "../utils/dealerLedgerHelper.js";
import User from "../models/user.model.js";

dotenv.config();

const dryRun = process.argv.includes("--dry-run");
const limitArg = process.argv.find((a) => a.startsWith("--limit="));
const orderIdArg = process.argv.find((a) => a.startsWith("--orderId="));
const limit = limitArg ? parseInt(limitArg.split("=")[1], 10) : 0;
const numericOrderId = orderIdArg ? parseInt(orderIdArg.split("=")[1], 10) : null;
const dealerIdArg = process.argv.find((a) => a.startsWith("--dealerId="));

async function main() {
  await mongoose.connect(process.env.MONGO_URI || process.env.MONGODB_URI);

  if (numericOrderId) {
    const order = await Order.findOne({ orderId: numericOrderId }).lean();
    if (!order) {
      console.error(`Order ${numericOrderId} not found`);
      process.exit(1);
    }
    const { syncDealerLedgerForOrder } = await import("../utils/dealerLedgerHelper.js");
    const { resolveFundingDealerId } = await import("../utils/farmerPlantOrderLedgerHelper.js");
    const dealerId = await resolveFundingDealerId(order);
    if (!dealerId) {
      console.error("No funding dealer for this order");
      process.exit(1);
    }
    if (dryRun) {
      console.log(`[dry-run] would sync order ${numericOrderId} for dealer ${dealerId}`);
    } else {
      const result = await syncDealerLedgerForOrder(order, {});
      console.log(JSON.stringify({ orderId: numericOrderId, dealerId: String(dealerId), ...result }, null, 2));
    }
    await mongoose.disconnect();
    return;
  }

  let dealerIds = [];
  if (dealerIdArg) {
    dealerIds = [dealerIdArg.split("=")[1]];
  } else {
    const dealers = await User.find({ jobTitle: "DEALER", isDisabled: { $ne: true } })
      .select("_id")
      .lean();
    dealerIds = dealers.map((d) => String(d._id));
    if (limit > 0) dealerIds = dealerIds.slice(0, limit);
  }

  const totals = { dealers: 0, scanned: 0, bookingsCreated: 0, paymentsCreated: 0 };

  for (const dealerId of dealerIds) {
    if (dryRun) {
      console.log(`[dry-run] would repair dealer ledger ${dealerId}`);
      continue;
    }
    const result = await repairDealerLedgerForDealer(dealerId, { limit: 500 });
    totals.dealers += 1;
    totals.scanned += result.scanned || 0;
    totals.bookingsCreated += result.bookingsCreated || 0;
    totals.paymentsCreated += result.paymentsCreated || 0;
    console.log(`Dealer ${dealerId}:`, result);
  }

  console.log(JSON.stringify({ dryRun, ...totals }, null, 2));

  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

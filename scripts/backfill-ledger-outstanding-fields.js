/**
 * One-off: set outstandingBefore / outstandingAfter on existing farmer plant ledger rows
 * (bypasses Mongoose immutability hooks via native collection bulkWrite).
 *
 * Usage:
 *   node scripts/backfill-ledger-outstanding-fields.js
 * Requires MONGODB_URI or DATABASE in env.
 */
import mongoose from "mongoose";
import FarmerPlantOrderLedgerEntry from "../models/farmerPlantOrderLedger.model.js";
import {
  sortLedgerEntriesCanonical,
  roundMoney,
} from "../utils/farmerPlantOrderLedgerHelper.js";

async function main() {
  const uri = process.env.MONGODB_URI || process.env.DATABASE;
  if (!uri) {
    console.error("Set MONGODB_URI or DATABASE");
    process.exit(1);
  }
  await mongoose.connect(uri);
  console.log("Connected. Backfilling outstandingBefore / outstandingAfter…");

  const all = await FarmerPlantOrderLedgerEntry.find({}).lean();
  const byMobile = new Map();
  for (const doc of all) {
    const key = doc.customerMobile;
    if (!key) continue;
    if (!byMobile.has(key)) byMobile.set(key, []);
    byMobile.get(key).push(doc);
  }

  const col = FarmerPlantOrderLedgerEntry.collection;
  let updated = 0;

  for (const [, docs] of byMobile) {
    const sorted = sortLedgerEntriesCanonical(docs);
    let running = 0;
    const ops = [];
    for (const entry of sorted) {
      const before = roundMoney(running);
      const net = roundMoney(
        (Number(entry.debit) || 0) - (Number(entry.credit) || 0)
      );
      running = roundMoney(running + net);
      const after = running;
      ops.push({
        updateOne: {
          filter: { _id: entry._id },
          update: {
            $set: {
              outstandingBefore: before,
              outstandingAfter: after,
            },
          },
        },
      });
    }
    if (ops.length) {
      const res = await col.bulkWrite(ops, { ordered: true });
      updated += res.modifiedCount ?? 0;
    }
  }

  console.log(`Done. Groups: ${byMobile.size}, documents updated: ${updated}`);
  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

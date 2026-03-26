/**
 * One-off: remove duplicate ORDER (plant booking) ledger rows per order.
 * Keeps the earliest document by createdAt (then _id). Run BEFORE creating the
 * uniq_farmer_plant_ledger_order_debit index if duplicates exist.
 *
 * Usage: node scripts/dedupe-farmer-plant-ledger-order-rows.js
 * Requires MONGODB_URI or DATABASE in env.
 */
import mongoose from "mongoose";
import FarmerPlantOrderLedgerEntry from "../models/farmerPlantOrderLedger.model.js";

async function main() {
  const uri = process.env.MONGODB_URI || process.env.DATABASE;
  if (!uri) {
    console.error("Set MONGODB_URI or DATABASE");
    process.exit(1);
  }
  await mongoose.connect(uri);
  const col = FarmerPlantOrderLedgerEntry.collection;

  const dupes = await col
    .aggregate([
      { $match: { refType: "ORDER" } },
      {
        $group: {
          _id: "$orderId",
          ids: { $push: "$_id" },
          count: { $sum: 1 },
        },
      },
      { $match: { count: { $gt: 1 } } },
    ])
    .toArray();

  let removed = 0;
  for (const g of dupes) {
    const docs = await col
      .find({ _id: { $in: g.ids } })
      .sort({ createdAt: 1, _id: 1 })
      .toArray();
    const [, ...rest] = docs;
    if (rest.length === 0) continue;
    const del = await col.deleteMany({ _id: { $in: rest.map((d) => d._id) } });
    removed += del.deletedCount || 0;
    console.log(
      `orderId ${g._id}: kept ${docs[0]._id}, removed ${rest.length} duplicate(s)`
    );
  }

  console.log(`Done. Removed ${removed} duplicate ORDER row(s).`);
  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

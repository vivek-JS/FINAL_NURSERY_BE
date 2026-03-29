/**
 * One-off: assign publicOrderCode to Orders missing it.
 * Usage: MONGO_URL=... node scripts/backfill-public-order-code.js
 */
import "dotenv/config";
import mongoose from "mongoose";
import Order from "../models/order.model.js";

async function main() {
  if (!process.env.MONGO_URL) {
    console.error("Set MONGO_URL");
    process.exit(1);
  }
  await mongoose.connect(process.env.MONGO_URL);
  const cursor = Order.find({
    $or: [{ publicOrderCode: { $exists: false } }, { publicOrderCode: null }, { publicOrderCode: "" }],
  }).cursor();

  let n = 0;
  for await (const doc of cursor) {
    await Order.ensurePublicOrderCode(doc);
    await doc.save();
    n += 1;
    if (n % 500 === 0) console.log("Updated", n);
  }
  console.log("Done. Updated", n, "orders.");
  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

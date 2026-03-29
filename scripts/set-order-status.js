/**
 * Set orderStatus directly in MongoDB (no API).
 *
 * Usage (from FINAL_NURSERY_BE, with .env or MONGO_URL):
 *   node scripts/set-order-status.js <id> <ORDER_STATUS>
 *
 * <id> is either a 24-char Mongo ObjectId or a numeric business orderId.
 *
 * Example:
 *   node scripts/set-order-status.js 507f1f77bcf86cd799439011 READY_FOR_DISPATCH
 *   node scripts/set-order-status.js 42 READY_FOR_DISPATCH
 */
import "dotenv/config";
import mongoose from "mongoose";
import Order from "../models/order.model.js";

const VALID = new Set([
  "PENDING",
  "PROCESSING",
  "COMPLETED",
  "CANCELLED",
  "DISPATCHED",
  "ACCEPTED",
  "REJECTED",
  "FARM_READY",
  "READY_FOR_DISPATCH",
  "DISPATCH_PROCESS",
  "PARTIALLY_COMPLETED",
  "TEMPORARY_CANCELLED",
]);

function isObjectIdString(s) {
  return /^[a-fA-F0-9]{24}$/.test(s);
}

async function main() {
  const [, , idArg, statusArg] = process.argv;
  if (!idArg || !statusArg) {
    console.error(
      "Usage: node scripts/set-order-status.js <mongoObjectId|orderId> <ORDER_STATUS>"
    );
    process.exit(1);
  }
  if (!VALID.has(statusArg)) {
    console.error("Invalid ORDER_STATUS. Allowed:", [...VALID].sort().join(", "));
    process.exit(1);
  }
  if (!process.env.MONGO_URL) {
    console.error("Set MONGO_URL (e.g. in .env)");
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGO_URL);

  const filter = isObjectIdString(idArg)
    ? { _id: new mongoose.Types.ObjectId(idArg) }
    : { orderId: Number(idArg) };

  const res = await Order.updateOne(filter, { $set: { orderStatus: statusArg } });

  if (res.matchedCount === 0) {
    console.error("No order matched:", filter);
    process.exit(1);
  }

  console.log("Updated orderStatus →", statusArg, "| matched:", res.matchedCount, "modified:", res.modifiedCount);
  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

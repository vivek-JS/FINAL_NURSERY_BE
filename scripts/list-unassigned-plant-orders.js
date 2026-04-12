/**
 * List plant orders with no salesPerson AND no dealer (legacy / data gaps).
 * Uses the same Mongo URI resolution as index.js and the same filters as
 * GET /api/v1/order/remaining-dispatch-orders?status=...&salesPerson=none&dealer=none
 *
 *   node scripts/list-unassigned-plant-orders.js
 *   node scripts/list-unassigned-plant-orders.js --status ACCEPTED
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import mongoose from "mongoose";
import Order from "../models/order.model.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "../.env") });

function resolveMongoUrl() {
  const isProd = process.env.NODE_ENV === "production";
  if (isProd) {
    return (
      process.env.PROD_MONGO_URL ||
      process.env.MONGO_URL ||
      process.env.MONGODB_URI ||
      ""
    );
  }
  return (
    process.env.MONGO_URL ||
    process.env.STAGE_MONGO_URL ||
    process.env.MONGODB_URI ||
    ""
  );
}

function argAfter(flag) {
  const i = process.argv.indexOf(flag);
  if (i === -1 || i + 1 >= process.argv.length) return null;
  return process.argv[i + 1];
}

const REMAINING_DISPATCH_STATUSES = [
  "ACCEPTED",
  "FARM_READY",
  "READY_FOR_DISPATCH",
  "DISPATCH_PROCESS",
];

const statusArg = argAfter("--status");
const statuses = statusArg
  ? [String(statusArg).trim()]
  : REMAINING_DISPATCH_STATUSES;

const uri = resolveMongoUrl();
if (!uri) {
  console.error(
    "Missing MongoDB URI. Set MONGO_URL (or STAGE_MONGO_URL / MONGODB_URI) in FINAL_NURSERY_BE/.env"
  );
  process.exit(1);
}

const unassignedMatch = {
  $and: [
    { orderStatus: { $in: statuses } },
    { $or: [{ salesPerson: null }, { salesPerson: { $exists: false } }] },
    { $or: [{ dealer: null }, { dealer: { $exists: false } }] },
  ],
};

async function main() {
  await mongoose.connect(uri);
  const rows = await Order.find(unassignedMatch)
    .select(
      "orderId orderStatus numberOfPlants dealerOrder orderBookingDate deliveryDate"
    )
    .sort({ orderBookingDate: -1 })
    .lean()
    .limit(5000);

  console.log(
    JSON.stringify(
      {
        count: rows.length,
        statuses,
        filter: "salesPerson null/missing AND dealer null/missing",
        orders: rows,
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

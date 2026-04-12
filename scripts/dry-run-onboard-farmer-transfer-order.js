/**
 * Dry-run: onboard farmer (by mobile/name) + preview transferring a plant order to them.
 * Usage:
 *   node scripts/dry-run-onboard-farmer-transfer-order.js
 *   node scripts/dry-run-onboard-farmer-transfer-order.js --prod-db   # use PROD_MONGO_URL from .env
 * Does not write to the database unless you add --execute (not implemented — dry run only).
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import mongoose from "mongoose";
import Order from "../models/order.model.js";
import Farmer from "../models/farmer.model.js";
import FarmerPlantOrderLedgerEntry from "../models/farmerPlantOrderLedger.model.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "../.env") });

const TARGET_MOBILE = 8007071129;
const TARGET_NAME = "Sachin Adhikar Patil";
const ORDER_DISPLAY_ID = 25261569;

function resolveMongoUrl(useProdDb) {
  if (useProdDb) {
    return (
      process.env.PROD_MONGO_URL ||
      process.env.MONGO_URL ||
      process.env.MONGODB_URI ||
      ""
    );
  }
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

async function main() {
  const useProdDb = process.argv.includes("--prod-db");
  const mongoUrl = resolveMongoUrl(useProdDb);
  if (!mongoUrl) {
    console.error("Missing Mongo URI. Set MONGO_URL or PROD_MONGO_URL in .env");
    process.exit(1);
  }

  const masked = mongoUrl.replace(/:[^:@/]+@/, ":****@");
  console.log("DB:", masked);
  console.log("Mode: DRY RUN (no writes)\n");

  await mongoose.connect(mongoUrl, {
    serverSelectionTimeoutMS: 15000,
  });

  const order = await Order.findOne({ orderId: ORDER_DISPLAY_ID })
    .populate("farmer", "name village mobileNumber")
    .lean();

  if (!order) {
    console.log(`Order orderId=${ORDER_DISPLAY_ID} not found on this cluster.`);
    console.log(
      "If the order is on production, re-run with: node scripts/dry-run-onboard-farmer-transfer-order.js --prod-db"
    );
    await mongoose.disconnect();
    process.exit(0);
  }

  const targetFarmer = await Farmer.findOne({ mobileNumber: TARGET_MOBILE }).lean();

  console.log("=== Order ===");
  console.log({
    _id: String(order._id),
    orderId: order.orderId,
    orderStatus: order.orderStatus,
    dealerOrder: order.dealerOrder,
    numberOfPlants: order.numberOfPlants,
    rate: order.rate,
  });

  console.log("\n=== Current farmer on order ===");
  if (order.farmer) {
    const f = order.farmer;
    console.log({
      _id: String(f._id),
      name: f.name,
      mobileNumber: f.mobileNumber,
      village: f.village,
    });
  } else {
    console.log("(none)");
  }

  console.log("\n=== Target farmer (lookup by mobile) ===");
  if (targetFarmer) {
    console.log("EXISTS:", {
      _id: String(targetFarmer._id),
      name: targetFarmer.name,
      mobileNumber: targetFarmer.mobileNumber,
      village: targetFarmer.village,
    });
    console.log(
      "\nOnboard: skip create — farmer already present. Name matches target?",
      String(targetFarmer.name).trim() === TARGET_NAME.trim()
        ? "yes"
        : `no (DB name: "${targetFarmer.name}", expected: "${TARGET_NAME}")`
    );
  } else {
    console.log("NOT FOUND — onboard would INSERT Farmer with:");
    console.log({
      name: TARGET_NAME,
      mobileNumber: TARGET_MOBILE,
      village: "To be updated",
      taluka: "To be updated",
      district: "To be updated",
      state: "Maharashtra",
      stateName: "Maharashtra",
      talukaName: "To be updated",
      districtName: "To be updated",
    });
  }

  const ledgerRows = await FarmerPlantOrderLedgerEntry.find({
    orderId: order._id,
  })
    .select("customerMobile customerName refType debit credit description entryDate")
    .sort({ entryDate: 1 })
    .lean();

  console.log("\n=== Farmer plant ledger rows for this order (by order ObjectId) ===");
  console.log("count:", ledgerRows.length);
  if (ledgerRows.length) {
    for (const r of ledgerRows) {
      console.log({
        customerMobile: r.customerMobile,
        refType: r.refType,
        debit: r.debit,
        credit: r.credit,
        description: r.description?.slice?.(0, 120),
      });
    }
    console.log(
      "\nNote: Changing order.farmer does not automatically rewrite ledger customerMobile."
    );
    console.log(
      "A real transfer usually needs ledger migration or support runbook — confirm with backend owner."
    );
  } else {
    console.log("(no ledger rows for this order id — may be dealer order or ledger not created yet)");
  }

  const newFarmerId = targetFarmer?._id ?? "(new ObjectId after create)";
  console.log("\n=== Transfer (preview only) ===");
  console.log("Would set order.farmer to:", String(newFarmerId));
  console.log(
    "Current → target same?",
    order.farmer && targetFarmer && String(order.farmer._id) === String(targetFarmer._id)
      ? "yes (no-op)"
      : "no"
  );

  await mongoose.disconnect();
  console.log("\nDone (dry run).");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

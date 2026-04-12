/**
 * Production one-off: create farmer (if missing), assign order to them, migrate ledger rows for that order.
 *
 *   node scripts/execute-onboard-farmer-transfer-order.js --prod-db --execute
 *
 * Without --execute: prints plan only (dry run).
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import mongoose from "mongoose";
import Order from "../models/order.model.js";
import Farmer from "../models/farmer.model.js";
import FarmerPlantOrderLedgerEntry from "../models/farmerPlantOrderLedger.model.js";
import {
  normalizeFarmerMobile,
  roundMoney,
  sortLedgerEntriesCanonical,
} from "../utils/farmerPlantOrderLedgerHelper.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "../.env") });

const TARGET_MOBILE_NUM = 8007071129;
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

async function recomputeOutstandingForCustomerMobile(customerMobile) {
  if (!customerMobile || !String(customerMobile).trim()) return;
  const col = FarmerPlantOrderLedgerEntry.collection;
  const raw = await col.find({ customerMobile: String(customerMobile).trim() }).toArray();
  const sorted = sortLedgerEntriesCanonical(raw);
  let running = 0;
  for (const doc of sorted) {
    const before = roundMoney(running);
    const d = Number(doc.debit || 0);
    const c = Number(doc.credit || 0);
    const after = roundMoney(before + d - c);
    await col.updateOne(
      { _id: doc._id },
      { $set: { outstandingBefore: before, outstandingAfter: after } }
    );
    running = after;
  }
}

async function main() {
  const useProdDb = process.argv.includes("--prod-db");
  const execute = process.argv.includes("--execute");
  const mongoUrl = resolveMongoUrl(useProdDb);
  if (!mongoUrl) {
    console.error("Missing Mongo URI.");
    process.exit(1);
  }

  console.log("Mode:", execute ? "EXECUTE (writes)" : "PLAN ONLY (no writes)");
  const masked = mongoUrl.replace(/:[^:@/]+@/, ":****@");
  console.log("DB:", masked);

  await mongoose.connect(mongoUrl, { serverSelectionTimeoutMS: 20000 });

  const order = await Order.findOne({ orderId: ORDER_DISPLAY_ID })
    .populate("farmer", "name mobileNumber")
    .exec();

  if (!order) {
    console.error(`Order orderId=${ORDER_DISPLAY_ID} not found.`);
    await mongoose.disconnect();
    process.exit(1);
  }

  let targetFarmer = await Farmer.findOne({ mobileNumber: TARGET_MOBILE_NUM });
  const oldFarmerId = order.farmer?._id || order.farmer;
  const oldMobileNorm = order.farmer?.mobileNumber
    ? normalizeFarmerMobile(order.farmer.mobileNumber)
    : null;

  const newMobileStr = normalizeFarmerMobile(TARGET_MOBILE_NUM);

  console.log("\nOrder:", order.orderId, "status:", order.orderStatus);
  console.log("Current farmer:", oldFarmerId ? String(oldFarmerId) : null, oldMobileNorm);
  console.log("Target:", TARGET_NAME, newMobileStr);

  if (targetFarmer) {
    console.log("Target farmer exists:", String(targetFarmer._id), targetFarmer.name);
  } else {
    console.log("Target farmer will be CREATED.");
  }

  const ledgerCol = FarmerPlantOrderLedgerEntry.collection;
  const ledgerForOrder = await ledgerCol
    .find({ orderId: order._id })
    .sort({ entryDate: 1 })
    .toArray();
  console.log("Ledger rows for this order:", ledgerForOrder.length);

  if (oldFarmerId && targetFarmer && String(oldFarmerId) === String(targetFarmer._id)) {
    console.log("\nAlready assigned to target farmer — nothing to do.");
    await mongoose.disconnect();
    return;
  }

  if (!execute) {
    console.log("\nRe-run with --execute to apply (requires --prod-db for production).");
    await mongoose.disconnect();
    return;
  }

  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    if (!targetFarmer) {
      const [created] = await Farmer.create(
        [
          {
            name: TARGET_NAME,
            mobileNumber: TARGET_MOBILE_NUM,
            village: "To be updated",
            taluka: "To be updated",
            district: "To be updated",
            state: "Maharashtra",
            stateName: "Maharashtra",
            talukaName: "To be updated",
            districtName: "To be updated",
          },
        ],
        { session }
      );
      targetFarmer = created;
      console.log("Created farmer:", String(targetFarmer._id));
    }

    await Order.findByIdAndUpdate(
      order._id,
      { $set: { farmer: targetFarmer._id } },
      { session }
    );
    console.log("Updated order.farmer ->", String(targetFarmer._id));

    await session.commitTransaction();
  } catch (e) {
    await session.abortTransaction();
    throw e;
  } finally {
    session.endSession();
  }

  // Ledger: bypass Mongoose immutability hooks via native collection.
  const updateRes = await ledgerCol.updateMany(
    { orderId: order._id },
    {
      $set: {
        customerMobile: newMobileStr,
        customerName: (targetFarmer.name || TARGET_NAME).trim(),
        farmer: targetFarmer._id,
      },
    }
  );
  console.log("Ledger rows updated (matched/modified):", updateRes.matchedCount, updateRes.modifiedCount);

  if (oldMobileNorm && oldMobileNorm !== newMobileStr) {
    await recomputeOutstandingForCustomerMobile(oldMobileNorm);
    console.log("Recomputed outstanding for old mobile:", oldMobileNorm);
  }
  await recomputeOutstandingForCustomerMobile(newMobileStr);
  console.log("Recomputed outstanding for new mobile:", newMobileStr);

  const verify = await Order.findById(order._id).populate("farmer", "name mobileNumber").lean();
  console.log("\nVerified order.farmer:", verify.farmer);

  await mongoose.disconnect();
  console.log("\nDone.");
}

main().catch(async (e) => {
  console.error(e);
  try {
    await mongoose.disconnect();
  } catch (_) {}
  process.exit(1);
});

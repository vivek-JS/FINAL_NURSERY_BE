/**
 * Backfill lagwad deduction for orders completed with shed_stock/manual batch but no plantsDeducted.
 *
 * Usage:
 *   node scripts/backfill-delivery-complete-shed-deduct.js
 *   ORDER_ID=3562 node scripts/backfill-delivery-complete-shed-deduct.js
 *   DRY_RUN=1 ORDER_ID=3562 node scripts/backfill-delivery-complete-shed-deduct.js
 */
import mongoose from "mongoose";
import dotenv from "dotenv";
import Order from "../models/order.model.js";
import Dispatch from "../models/dispatch.model.js";
import { applyCompleteDispatchShedDeduction } from "../services/completeDispatchShedDeduction.service.js";

dotenv.config();

const DRY_RUN = String(process.env.DRY_RUN || "") === "1";
const ORDER_ID_FILTER = process.env.ORDER_ID
  ? Number(process.env.ORDER_ID)
  : null;

async function main() {
  const uri =
    process.env.MONGO_URI ||
    process.env.MONGODB_URI ||
    process.env.MONGO_URL ||
    process.env.DATABASE_URL;
  if (!uri) {
    console.error("Set MONGO_URI, MONGO_URL, or MONGODB_URI");
    process.exit(1);
  }
  await mongoose.connect(uri);

  const query = {
    "deliveryCompleteBatch.batchNumber": { $exists: true, $ne: "" },
    "deliveryCompleteBatch.source": { $in: ["shed_stock", "manual"] },
    $or: [
      { "deliveryCompleteBatch.plantsDeducted": { $exists: false } },
      { "deliveryCompleteBatch.plantsDeducted": null },
      { "deliveryCompleteBatch.plantsDeducted": 0 },
    ],
    "deliveryCompleteBatch.secondaryOutwardId": { $exists: false },
  };
  if (ORDER_ID_FILTER) {
    query.orderId = ORDER_ID_FILTER;
  }

  const orders = await Order.find(query)
    .select(
      "orderId deliveryCompleteBatch returnedPlants damagedPlants numberOfPlants additionalPlants remainingPlants dispatchHistory"
    )
    .limit(ORDER_ID_FILTER ? 5 : 200)
    .lean();

  console.log(`Found ${orders.length} order(s) to backfill (dryRun=${DRY_RUN})`);

  for (const orderLean of orders) {
    const orderId = orderLean._id;
    let dispatch = await Dispatch.findOne({ orderIds: orderId })
      .sort({ updatedAt: -1 })
      .lean();
    if (!dispatch) {
      const dispatchId =
        orderLean.dispatchHistory?.[orderLean.dispatchHistory.length - 1]
          ?.dispatchId ||
        orderLean.dispatchHistory?.find((h) => h?.dispatchId)?.dispatchId;
      if (dispatchId) {
        dispatch = await Dispatch.findById(dispatchId).lean();
      }
    }
    if (!dispatch) {
      console.warn(`Order #${orderLean.orderId}: no dispatch found — skip`);
      continue;
    }
    const batchSnapshot = {
      ...orderLean.deliveryCompleteBatch,
      capturedAt: orderLean.deliveryCompleteBatch.capturedAt || new Date(),
    };

    if (DRY_RUN) {
      console.log(
        `DRY_RUN would deduct for order #${orderLean.orderId} batch=${batchSnapshot.batchNumber} shed=${batchSnapshot.pollyhouse}`
      );
      continue;
    }

    const session = await mongoose.startSession();
    session.startTransaction();
    try {
      const order = await Order.findById(orderId).session(session);
      const result = await applyCompleteDispatchShedDeduction({
        session,
        order,
        dispatch,
        batchSnapshot,
        returnsForThisOrder: 0,
        damagedForThisOrder: 0,
        performedBy: undefined,
      });

      if (result.skipped) {
        console.log(
          `Order #${orderLean.orderId}: skipped (${result.reason})`
        );
        await session.abortTransaction();
        continue;
      }

      await Order.findByIdAndUpdate(
        orderId,
        { $set: { deliveryCompleteBatch: result.batchSnapshot } },
        { session }
      );
      await session.commitTransaction();
      console.log(
        `Order #${orderLean.orderId}: deducted ${result.plantsDeducted} plants (outward ${result.secondaryOutwardId})`
      );
    } catch (err) {
      await session.abortTransaction();
      console.error(`Order #${orderLean.orderId}:`, err.message || err);
    } finally {
      session.endSession();
    }
  }

  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

/**
 * One-off: create Lalasaheb farmer, assign order #2171, migrate ledger, audit + timeline.
 *
 *   node scripts/onboard-lalasaheb-order-2171.js --prod-db --execute
 *   node scripts/onboard-lalasaheb-order-2171.js --prod-db --backfill-timeline
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import mongoose from "mongoose";
import Order from "../models/order.model.js";
import {
  findOrCreateFarmer,
  reassignOrderFarmerWithAudit,
  emitFarmerEditHistoryToTimeline,
} from "../services/reassignOrderFarmer.service.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "../.env") });

const ORDER_DISPLAY_ID = 2171;
const TARGET = {
  name: "Lalasaheb bhau yajgar",
  mobileNumber: 9922972476,
  village: "Karole",
  taluka: "Pandharpur",
  district: "Solapur",
  state: "Maharashtra",
  stateName: "Maharashtra",
  talukaName: "Pandharpur",
  districtName: "Solapur",
};
const SUPER_ADMIN_ID = "6976c986299fa0215edc853d";

function resolveMongoUrl(useProdDb) {
  if (useProdDb) {
    return process.env.PROD_MONGO_URL || process.env.MONGO_URL || process.env.MONGODB_URI || "";
  }
  return process.env.MONGO_URL || process.env.STAGE_MONGO_URL || process.env.MONGODB_URI || "";
}

async function main() {
  const useProdDb = process.argv.includes("--prod-db");
  const execute = process.argv.includes("--execute");
  const backfillTimeline = process.argv.includes("--backfill-timeline");
  const mongoUrl = resolveMongoUrl(useProdDb);
  if (!mongoUrl) {
    console.error("Missing Mongo URI.");
    process.exit(1);
  }

  console.log("Mode:", backfillTimeline ? "BACKFILL TIMELINE" : execute ? "EXECUTE" : "PLAN ONLY");
  await mongoose.connect(mongoUrl, { serverSelectionTimeoutMS: 20000 });

  const order = await Order.findOne({ orderId: ORDER_DISPLAY_ID })
    .populate("farmer", "name mobileNumber")
    .exec();
  if (!order) {
    console.error(`Order ${ORDER_DISPLAY_ID} not found.`);
    process.exit(1);
  }

  if (backfillTimeline) {
    const entry = (order.orderEditHistory || []).find((h) => h.field === "farmer");
    if (!entry) {
      console.error("No farmer orderEditHistory entry to backfill.");
      process.exit(1);
    }
    const emitted = await emitFarmerEditHistoryToTimeline(order._id, entry, {
      actorName: "Super Admin",
    });
    console.log("Backfill emitted events:", emitted?.length ?? 0);
    await mongoose.disconnect();
    return;
  }

  console.log("Order:", order.orderId, order.orderStatus);
  console.log("Current farmer:", order.farmer?.name, order.farmer?.mobileNumber);

  if (!execute) {
    console.log("\nRe-run with --prod-db --execute to apply.");
    console.log("If farmer already reassigned, use --backfill-timeline to emit missing OrderEvent.");
    await mongoose.disconnect();
    return;
  }

  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const targetFarmer = await findOrCreateFarmer(TARGET, { session });
    const previousFarmerName = order.farmer?.name || "";

    await reassignOrderFarmerWithAudit({
      order,
      targetFarmerId: targetFarmer._id,
      targetFarmerName: targetFarmer.name || TARGET.name,
      targetMobile: String(targetFarmer.mobileNumber || TARGET.mobileNumber),
      previousFarmerName,
      actorId: SUPER_ADMIN_ID,
      actorName: "Super Admin",
      session,
      emitTimelineEvent: true,
    });

    await session.commitTransaction();
    console.log("Done. Farmer:", String(targetFarmer._id), targetFarmer.name);
  } catch (e) {
    await session.abortTransaction();
    throw e;
  } finally {
    session.endSession();
    await mongoose.disconnect();
  }
}

main().catch(async (e) => {
  console.error(e);
  try {
    await mongoose.disconnect();
  } catch (_) {}
  process.exit(1);
});

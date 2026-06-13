/**
 * Diagnose booked vs remaining-to-dispatch for a plant/subtype slot window.
 * Usage: node scripts/diagnose-slot-booked-vs-dispatch.mjs
 */
import mongoose from "mongoose";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

import PlantSlot from "../models/slots.model.js";
import Order from "../models/order.model.js";
import PlantCms from "../models/plantCms.model.js";
import {
  groupOrdersByDeliverySlot,
  computeSlotDispatchStatsFromOrders,
  getNativeDeliveryCohortOrders,
  getDispatchedAndCompletedQty,
  getRemainingToDispatchQty,
  isSlotStatEligibleOrder,
} from "../utility/slotDispatchStats.js";
import { isPastDueRolledInOrder } from "../utility/pastDueSlotMetrics.js";
import { getOrderTotalPlants } from "../services/dealerCommission.service.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "../.env") });

const PLANT_ID = "68fdf6d45832d541b274acfa";
const SUBTYPE_ID = "6944c7e75845df7093731ba2";
const YEAR = 2026;
const SLOT_LABEL = "02-07-2026|08-07-2026";

function orderPlants(o) {
  return getOrderTotalPlants(o);
}

async function main() {
  const uri = process.env.PROD_MONGO_URL;
  if (!uri) throw new Error("PROD_MONGO_URL not set");
  await mongoose.connect(uri);
  console.log("Connected to prod DB\n");

  const plant = await PlantCms.findById(PLANT_ID).select("name").lean();
  const plantSlot = await PlantSlot.findOne({ plantId: PLANT_ID, year: YEAR }).lean();
  const subtypeSlot = plantSlot?.subtypeSlots?.find(
    (s) => s.subtypeId?.toString() === SUBTYPE_ID
  );
  const targetSlot = subtypeSlot?.slots?.find(
    (s) => `${s.startDay}|${s.endDay}` === SLOT_LABEL
  );

  if (!targetSlot) {
    console.error("Slot not found:", SLOT_LABEL);
    process.exit(1);
  }

  const slotId = targetSlot._id.toString();
  console.log(`Plant: ${plant?.name || PLANT_ID}`);
  console.log(`Subtype: ${subtypeSlot?.subtypeName || SUBTYPE_ID}`);
  console.log(`Slot: ${targetSlot.startDay} – ${targetSlot.endDay} (${slotId})`);
  console.log("---\n");

  const baseMatch = {
    plantName: new mongoose.Types.ObjectId(PLANT_ID),
    plantSubtype: new mongoose.Types.ObjectId(SUBTYPE_ID),
    orderStatus: { $nin: ["CANCELLED", "REJECTED", "TEMPORARY_CANCELLED"] },
    $or: [{ quotaSource: { $ne: "dealer" } }, { quotaSource: { $exists: false } }],
  };

  const allOrders = await Order.find(baseMatch)
    .select(
      "orderId orderStatus numberOfPlants additionalPlants deliveryDate bookingSlot pastDueSlotRollover pastDueSlotRolloverAt quotaSource"
    )
    .lean();

  const ordersByDelivery = groupOrdersByDeliverySlot(allOrders, subtypeSlot.slots);
  const deliveryOrders = ordersByDelivery.get(slotId) || [];
  const nativeDelivery = getNativeDeliveryCohortOrders(deliveryOrders);
  const dispatchStats = computeSlotDispatchStatsFromOrders([], {
    bookedOrders: nativeDelivery,
    pipelineOrders: nativeDelivery,
  });

  console.log("API-style stats (delivery-window cohort, excl rolled-in):");
  console.log(`  totalBookedPlants:    ${dispatchStats.totalBookedPlants}`);
  console.log(`  remainingToDispatch:  ${dispatchStats.remainingToDispatch}`);
  console.log(`  totalDispatchedPlants:${dispatchStats.totalDispatchedPlants}`);
  console.log(
    `  identity check booked = remaining + dispatched: ${dispatchStats.totalBookedPlants} = ${dispatchStats.remainingToDispatch + dispatchStats.totalDispatchedPlants}`
  );
  console.log("---\n");

  const byStatus = {};
  let rolledInPlants = 0;
  let excludedOther = 0;

  for (const o of deliveryOrders) {
    const plants = orderPlants(o);
    const status = o.orderStatus || "UNKNOWN";
    byStatus[status] = (byStatus[status] || 0) + plants;
    if (isPastDueRolledInOrder(o)) rolledInPlants += plants;
    if (!isSlotStatEligibleOrder(o)) excludedOther += plants;
  }

  console.log("All orders with deliveryDate in slot window (by status):");
  for (const [status, plants] of Object.entries(byStatus).sort((a, b) => b[1] - a[1])) {
    const remaining = status === "ACCEPTED" || status === "FARM_READY" || status === "READY_FOR_DISPATCH" ? " ← counts in remaining" : "";
    const dispatched = status === "DISPATCHED" || status === "COMPLETED" ? " ← counts in dispatched (not remaining)" : "";
    console.log(`  ${status.padEnd(22)} ${String(plants).padStart(7)}${remaining}${dispatched}`);
  }
  console.log(`  ${"TOTAL".padEnd(22)} ${String(Object.values(byStatus).reduce((a, b) => a + b, 0)).padStart(7)}`);
  console.log(`\nPast-due rolled-in in window (excluded from booked): ${rolledInPlants}`);

  const notInRemaining = nativeDelivery.filter(
    (o) => getRemainingToDispatchQty(o) === 0 && getDispatchedAndCompletedQty(o) === 0
  );
  if (notInRemaining.length) {
    console.log("\nOrders in booked but NOT in remaining or dispatched:");
    let sum = 0;
    for (const o of notInRemaining) {
      const p = orderPlants(o);
      sum += p;
      console.log(`  #${o.orderId}  ${o.orderStatus}  ${p} plants`);
    }
    console.log(`  Subtotal: ${sum} plants (likely PENDING / DISPATCH_PROCESS / etc.)`);
  }

  const dispatchedOrders = nativeDelivery.filter((o) => getDispatchedAndCompletedQty(o) > 0);
  if (dispatchedOrders.length) {
    console.log(`\nDispatched/Completed orders (${dispatchStats.totalDispatchedPlants} plants):`);
    for (const o of dispatchedOrders) {
      console.log(`  #${o.orderId}  ${o.orderStatus}  ${orderPlants(o)} plants`);
    }
  }

  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

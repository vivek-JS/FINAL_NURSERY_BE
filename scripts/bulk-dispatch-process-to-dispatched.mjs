/**
 * DISPATCH_PROCESS orders with remainingPlants 0 and an active vehicle → DISPATCHED.
 *
 *   node scripts/bulk-dispatch-process-to-dispatched.mjs          # dry run
 *   node scripts/bulk-dispatch-process-to-dispatched.mjs --apply  # write
 */
import "dotenv/config";
import mongoose from "mongoose";
import Order from "../models/order.model.js";
import Dispatch from "../models/dispatch.model.js";
import "../models/farmer.model.js";

const APPLY = process.argv.includes("--apply");
const REASON = "script:bulk_dispatch_process_to_dispatched";

const hasVehicle = (d) =>
  Boolean(
    String(d?.vehicleName || "").trim() ||
      String(d?.vehicleNumber || "").trim() ||
      d?.vehicleId
  );

const remainingBucket = (o) => {
  const r = o.remainingPlants;
  if (r == null || !Number.isFinite(Number(r))) return "remaining empty";
  if (Number(r) === 0) return "remaining 0";
  if (Number(r) < 0) return "remaining < 0";
  return "remaining > 0";
};

async function main() {
  if (!process.env.MONGO_URL) throw new Error("Set MONGO_URL");
  await mongoose.connect(process.env.MONGO_URL);

  const statusCounts = await Order.aggregate([
    { $group: { _id: "$orderStatus", count: { $sum: 1 } } },
    { $sort: { count: -1 } },
  ]);

  const orders = await Order.find({ orderStatus: "DISPATCH_PROCESS" })
    .select(
      "_id orderId remainingPlants numberOfPlants additionalPlants currentDispatchId farmer"
    )
    .populate("farmer", "name mobileNumber")
    .lean();

  const dispatchIds = [
    ...new Set(orders.map((o) => o.currentDispatchId).filter(Boolean).map(String)),
  ];
  const dispatches = await Dispatch.find({ _id: { $in: dispatchIds } })
    .select("_id transportId vehicleName vehicleNumber vehicleId transportStatus isDeleted")
    .lean();
  const dispatchById = new Map(dispatches.map((d) => [String(d._id), d]));

  const eligible = [];
  const categories = new Map();
  const bump = (key) => categories.set(key, (categories.get(key) || 0) + 1);

  for (const o of orders) {
    const remaining = remainingBucket(o);
    const d = o.currentDispatchId ? dispatchById.get(String(o.currentDispatchId)) : null;
    let vehicleState;
    if (!o.currentDispatchId) vehicleState = "no current dispatch";
    else if (!d) vehicleState = "dispatch not found";
    else if (d.isDeleted) vehicleState = "dispatch deleted";
    else if (!hasVehicle(d)) vehicleState = "dispatch has no vehicle";
    else vehicleState = "active vehicle";

    bump(`${remaining} | ${vehicleState}`);
    if (remaining === "remaining 0" && vehicleState === "active vehicle") {
      eligible.push({ o, d });
    }
  }

  console.log(`Mode: ${APPLY ? "APPLY" : "DRY RUN"}\n`);
  console.log("All orders by status:");
  console.table(statusCounts.map((s) => ({ status: s._id, count: s.count })));

  console.log(`\nDISPATCH_PROCESS orders: ${orders.length}`);
  console.table(
    [...categories.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([k, count]) => {
        const [remaining, vehicle] = k.split(" | ");
        return { remaining, vehicle, count };
      })
  );

  console.log(`\nEligible for DISPATCHED (remaining 0 + active vehicle): ${eligible.length}`);
  console.table(
    eligible.map(({ o, d }) => ({
      orderId: o.orderId,
      farmer: o.farmer?.name || "",
      plants: Number(o.numberOfPlants || 0) + Number(o.additionalPlants || 0),
      remaining: o.remainingPlants,
      transportId: d.transportId,
      vehicle: d.vehicleNumber || d.vehicleName || String(d.vehicleId || ""),
      transportStatus: d.transportStatus,
    }))
  );

  if (!APPLY) {
    console.log("\nDry run only. Re-run with --apply to update.");
    return;
  }

  let modified = 0;
  for (const { o } of eligible) {
    const res = await Order.updateOne(
      { _id: o._id, orderStatus: "DISPATCH_PROCESS", remainingPlants: 0 },
      {
        $set: { orderStatus: "DISPATCHED" },
        $push: {
          statusChanges: {
            previousStatus: "DISPATCH_PROCESS",
            newStatus: "DISPATCHED",
            reason: REASON,
          },
        },
      }
    );
    modified += res.modifiedCount;
  }
  console.log(`\nUpdated ${modified} / ${eligible.length} orders to DISPATCHED.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());

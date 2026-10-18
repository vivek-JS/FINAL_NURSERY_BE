/**
 * Read-only: print sow-batch-options for one pending vehicle that has a seed-sown row.
 * Also prints order 4151 when that order is on the vehicle, next to its sowing link.
 *
 *   node scripts/print-sow-batch-options.mjs
 */
import "dotenv/config";
import mongoose from "mongoose";
import PlantCms from "../models/plantCms.model.js";
import Dispatch from "../models/dispatch.model.js";
import Order from "../models/order.model.js";
import { listSowBatchOptionsForDispatch } from "../services/sowDispatchBatches.service.js";

const url = process.env.MONGO_URL || process.env.MONGODB_URI;
if (!url) {
  console.error("MONGO_URL is not set");
  process.exit(1);
}

await mongoose.connect(url);

const plants = await PlantCms.find({ sowingAllowed: true }).select("_id name").lean();
const plantIds = new Set(plants.map((p) => String(p._id)));
const nameOf = new Map(plants.map((p) => [String(p._id), p.name || ""]));

const vehicles = await Dispatch.find({
  isDeleted: { $ne: true },
  transportStatus: { $in: ["PENDING", "IN_TRANSIT"] },
})
  .select("transportId transportStatus plantsDetails orderIds")
  .sort({ createdAt: -1 })
  .limit(40)
  .lean();

const vehicle = vehicles.find((d) =>
  (d.plantsDetails || []).some((row) => plantIds.has(String(row.plantId)))
);

if (!vehicle) {
  console.log("No pending vehicle with a seed-sown plant row.");
  await mongoose.disconnect();
  process.exit(0);
}

const rowIndex = (vehicle.plantsDetails || []).findIndex((row) =>
  plantIds.has(String(row.plantId))
);
const row = vehicle.plantsDetails[rowIndex];
console.log(
  `Vehicle ${vehicle.transportId || vehicle._id} ${vehicle.transportStatus} row ${rowIndex} ${nameOf.get(String(row.plantId)) || ""} qty ${row.quantity ?? row.totalPlants ?? ""}`
);

const options = await listSowBatchOptionsForDispatch(vehicle._id, rowIndex);
console.log(
  `Orders ${options.orders.length} · batches ${options.batches.length} · row remaining ${options.rowRemaining}`
);
for (const o of options.orders) {
  const linked = (o.linked || [])
    .map((l) => `${l.plantReadyDate || l.sowingDate} ${l.requestNumber || ""} (${l.linkedPlants})`)
    .join("; ");
  console.log(
    `  #${o.orderCode || o.orderNo} ${o.farmerName} remaining ${o.remainingOnVehicle} linked: ${linked || "none"}`
  );
}

const target = await Order.findOne({ orderId: 4151 })
  .select("orderId publicOrderCode sowingDone sowingDoneRequestId sowingCoverSources sowingCoverReversedAt sowBatchLinks")
  .lean();
const onVehicle = target && options.orders.some((o) => String(o.orderNo) === "4151" || o.orderCode === "4151");
if (!target) {
  console.log("Order 4151: not found");
} else if (!onVehicle) {
  console.log(`Order 4151: not on this vehicle (sowingDone=${Boolean(target.sowingDone)})`);
} else {
  const shown = options.orders.find((o) => String(o.orderNo) === "4151" || o.orderCode === "4151");
  console.log("Order 4151 sowing:");
  console.log(
    JSON.stringify(
      {
        sowingDoneRequestId: target.sowingDoneRequestId || null,
        coverReversed: Boolean(target.sowingCoverReversedAt),
        covers: (target.sowingCoverSources || []).map((s) => ({
          batchId: String(s.moved ? s.destBatchId : s.batchId),
          plants: s.plants,
          moved: Boolean(s.moved),
          ready: s.plantReadyDate,
        })),
        links: (target.sowBatchLinks || []).map((l) => ({
          reason: l.reason,
          batchId: l.batchId ? String(l.batchId) : "",
          fromBatchId: l.fromBatchId ? String(l.fromBatchId) : "",
          plants: l.plants,
          ready: l.plantReadyDate || "",
        })),
        optionLinked: (shown?.linked || []).map((l) => ({
          batchId: l.batchId,
          plants: l.linkedPlants,
          ready: l.plantReadyDate,
        })),
      },
      null,
      2
    )
  );
}

await mongoose.disconnect();

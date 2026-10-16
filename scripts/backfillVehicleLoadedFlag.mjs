/**
 * One-time: mark orders on vehicles created before the cutoff (default: today 00:00 IST) as vehicleLoaded,
 * so only new vehicles go through the shed load flow. Sets whatsappDispatchSentQty = loaded qty so the
 * backfill never triggers a farmer WhatsApp. Orders also on a vehicle created after the cutoff are skipped.
 *
 *   node scripts/backfillVehicleLoadedFlag.mjs            # dry run
 *   node scripts/backfillVehicleLoadedFlag.mjs --apply
 *   node scripts/backfillVehicleLoadedFlag.mjs --cutoff=2026-10-16T00:00:00+05:30 --apply
 */
import "dotenv/config";
import mongoose from "mongoose";
import Order from "../models/order.model.js";
import Dispatch from "../models/dispatch.model.js";

const APPLY = process.argv.includes("--apply");
const cutoffArg = process.argv.find((a) => a.startsWith("--cutoff="))?.split("=")[1];
const cutoff = cutoffArg ? new Date(cutoffArg) : (() => {
  const istNow = new Date(Date.now() + 5.5 * 3600 * 1000);
  const istMidnightUtc = Date.UTC(istNow.getUTCFullYear(), istNow.getUTCMonth(), istNow.getUTCDate());
  return new Date(istMidnightUtc - 5.5 * 3600 * 1000);
})();

const orderIdsOf = (d) => {
  const ids = new Set();
  for (const id of d.orderIds || []) if (id) ids.add(String(id?._id || id));
  for (const r of d.orderDispatchDetails || []) if (r?.orderId) ids.add(String(r.orderId));
  return ids;
};

await mongoose.connect(process.env.MONGO_URL || process.env.MONGODB_URI);
console.log(`Cutoff: ${cutoff.toISOString()}  mode: ${APPLY ? "APPLY" : "DRY RUN"}`);

const notDeleted = { isDeleted: { $ne: true } };
const fields = "_id createdAt transportStatus orderIds orderDispatchDetails";
const [oldVehicles, newVehicles] = await Promise.all([
  Dispatch.find({ ...notDeleted, createdAt: { $lt: cutoff } }).select(fields).sort({ createdAt: 1 }).lean(),
  Dispatch.find({ ...notDeleted, createdAt: { $gte: cutoff } }).select(fields).lean(),
]);

const statusCount = {};
for (const d of oldVehicles) {
  const s = d.transportStatus || "(none)";
  statusCount[s] = (statusCount[s] || 0) + 1;
}
console.log(`Vehicles before cutoff: ${oldVehicles.length}  by transportStatus:`, statusCount);
console.log(`Vehicles from cutoff (left unflagged): ${newVehicles.length}`);

const onNewVehicle = new Set();
for (const d of newVehicles) for (const id of orderIdsOf(d)) onNewVehicle.add(id);

/** Latest old vehicle per order wins (sorted ascending). */
const latest = new Map();
for (const d of oldVehicles) {
  for (const id of orderIdsOf(d)) {
    const row = (d.orderDispatchDetails || []).find((r) => String(r.orderId) === id);
    latest.set(id, { dispatch: d, row });
  }
}

const candidateIds = [...latest.keys()].filter((id) => !onNewVehicle.has(id));
const orders = await Order.find({ _id: { $in: candidateIds } })
  .select("_id vehicleLoaded dispatchHistory")
  .lean();

let alreadyFlagged = 0;
let zeroQty = 0;
const ops = [];
for (const o of orders) {
  if (o.vehicleLoaded) { alreadyFlagged++; continue; }
  const { dispatch, row } = latest.get(String(o._id));
  let qty = Number(row?.shedLoadedQuantity) || Number(row?.dispatchQuantity) || 0;
  if (!qty) {
    qty = (o.dispatchHistory || [])
      .filter((h) => String(h?.dispatchId || "") === String(dispatch._id))
      .reduce((s, h) => s + (Number(h?.quantity) || 0), 0);
  }
  if (!qty) zeroQty++;
  ops.push({
    updateOne: {
      filter: { _id: o._id, vehicleLoaded: { $ne: true } },
      update: {
        $set: {
          vehicleLoaded: true,
          vehicleLoadedQuantity: qty,
          vehicleLoadedDispatchId: dispatch._id,
          vehicleLoadedAt: dispatch.createdAt,
          whatsappDispatchSentQty: qty,
        },
      },
    },
  });
}

console.log(`Orders on old vehicles: ${latest.size}`);
console.log(`  skipped (also on a vehicle from cutoff): ${latest.size - candidateIds.length}`);
console.log(`  missing order docs: ${candidateIds.length - orders.length}`);
console.log(`  already flagged: ${alreadyFlagged}`);
console.log(`  to flag: ${ops.length}  (of which qty unknown -> 0: ${zeroQty})`);

if (APPLY && ops.length) {
  let modified = 0;
  for (let i = 0; i < ops.length; i += 500) {
    const res = await Order.bulkWrite(ops.slice(i, i + 500), { ordered: false });
    modified += res.modifiedCount;
  }
  console.log(`Updated orders: ${modified}`);
}

await mongoose.disconnect();

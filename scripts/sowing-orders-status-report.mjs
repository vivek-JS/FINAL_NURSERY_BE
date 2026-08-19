/**
 * Sowing-allowed orders booked from 1-Jul — counts by status + sowingDone.
 *
 *   node scripts/sowing-orders-status-report.mjs
 *   node scripts/sowing-orders-status-report.mjs --year=2026
 *   node scripts/sowing-orders-status-report.mjs --from=2026-07-01
 */
import dotenv from "dotenv";
import mongoose from "mongoose";
import path from "path";
import { fileURLToPath } from "url";
import PlantCms from "../models/plantCms.model.js";
import Order from "../models/order.model.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "../.env") });

const fromArg = process.argv.find((a) => a.startsWith("--from="));
const yearArg = process.argv.find((a) => a.startsWith("--year="));
const YEAR = yearArg ? parseInt(yearArg.split("=")[1], 10) : 2026;
const FROM = fromArg
  ? fromArg.split("=")[1]
  : `${YEAR}-07-01`;

const fmt = (n) => Number(n || 0).toLocaleString("en-IN");

const ACTIVE = [
  "PENDING",
  "PROCESSING",
  "ACCEPTED",
  "FARM_READY",
  "READY_FOR_DISPATCH",
  "DISPATCH_PROCESS",
  "PARTIALLY_COMPLETED",
];

const DISPATCHED_LIKE = ["DISPATCHED", "COMPLETED", "PARTIALLY_COMPLETED"];
const READY_DISPATCH = ["FARM_READY", "READY_FOR_DISPATCH", "DISPATCH_PROCESS"];

function istDayStart(isoYmd) {
  const [y, m, d] = isoYmd.split("-").map(Number);
  const IST = 5.5 * 60 * 60 * 1000;
  return new Date(Date.UTC(y, m - 1, d, 0, 0, 0, 0) - IST);
}

async function main() {
  const fromDate = istDayStart(FROM);
  console.log("=== Sowing-allowed orders · status report ===");
  console.log(`Booking from: ${FROM} (IST) · sowingAllowed plants only\n`);

  await mongoose.connect(process.env.PROD_MONGO_URL);

  const plants = await PlantCms.find({ sowingAllowed: true })
    .select("name subtypes.name subtypes._id")
    .lean();
  const plantIds = plants.map((p) => p._id);
  const plantMap = new Map(plants.map((p) => [String(p._id), p]));
  const subtypeMap = new Map();
  for (const p of plants) {
    for (const st of p.subtypes || []) {
      subtypeMap.set(String(st._id), { plantName: p.name, subtypeName: st.name });
    }
  }

  const baseMatch = {
    plantName: { $in: plantIds },
    $or: [
      { orderBookingDate: { $gte: fromDate } },
      {
        orderBookingDate: { $in: [null, undefined] },
        createdAt: { $gte: fromDate },
      },
    ],
  };

  const pipeline = [
    { $match: baseMatch },
    {
      $addFields: {
        plants: {
          $add: [
            { $ifNull: ["$numberOfPlants", 0] },
            { $ifNull: ["$additionalPlants", 0] },
          ],
        },
      },
    },
    {
      $group: {
        _id: {
          status: "$orderStatus",
          sowingDone: { $ifNull: ["$sowingDone", false] },
        },
        orders: { $sum: 1 },
        plants: { $sum: "$plants" },
      },
    },
    { $sort: { "_id.status": 1 } },
  ];

  const rows = await Order.aggregate(pipeline);

  const byStatus = new Map();
  let totalOrders = 0;
  let totalPlants = 0;
  for (const r of rows) {
    const st = r._id.status || "UNKNOWN";
    if (!byStatus.has(st)) {
      byStatus.set(st, { orders: 0, plants: 0, sowed: 0, unsowed: 0, sowedPlants: 0, unsowedPlants: 0 });
    }
    const b = byStatus.get(st);
    b.orders += r.orders;
    b.plants += r.plants;
    if (r._id.sowingDone) {
      b.sowed += r.orders;
      b.sowedPlants += r.plants;
    } else {
      b.unsowed += r.orders;
      b.unsowedPlants += r.plants;
    }
    totalOrders += r.orders;
    totalPlants += r.plants;
  }

  console.log(`Plants (sowing allowed): ${plants.map((p) => p.name).join(", ")}\n`);

  console.log("── By orderStatus ──");
  console.log(
    "Status".padEnd(22) +
      "Orders".padStart(8) +
      "Plants".padStart(12) +
      "Sowed".padStart(8) +
      "Unsowed".padStart(8) +
      "SowedPlt".padStart(12) +
      "UnsowedPlt".padStart(12)
  );
  console.log("-".repeat(82));

  const statusOrder = [
    "PENDING",
    "PROCESSING",
    "ACCEPTED",
    "FARM_READY",
    "READY_FOR_DISPATCH",
    "DISPATCH_PROCESS",
    "DISPATCHED",
    "PARTIALLY_COMPLETED",
    "COMPLETED",
    "CANCELLED",
    "TEMPORARY_CANCELLED",
    "REJECTED",
  ];

  const seen = new Set();
  for (const st of statusOrder) {
    if (!byStatus.has(st)) continue;
    seen.add(st);
    const b = byStatus.get(st);
    console.log(
      st.padEnd(22) +
        String(b.orders).padStart(8) +
        fmt(b.plants).padStart(12) +
        String(b.sowed).padStart(8) +
        String(b.unsowed).padStart(8) +
        fmt(b.sowedPlants).padStart(12) +
        fmt(b.unsowedPlants).padStart(12)
    );
  }
  for (const [st, b] of byStatus) {
    if (seen.has(st)) continue;
    console.log(
      st.padEnd(22) +
        String(b.orders).padStart(8) +
        fmt(b.plants).padStart(12) +
        String(b.sowed).padStart(8) +
        String(b.unsowed).padStart(8) +
        fmt(b.sowedPlants).padStart(12) +
        fmt(b.unsowedPlants).padStart(12)
    );
  }
  console.log("-".repeat(82));
  console.log(
    "TOTAL".padEnd(22) +
      String(totalOrders).padStart(8) +
      fmt(totalPlants).padStart(12)
  );

  const sum = (statuses, field = "orders") =>
    statuses.reduce((s, st) => s + (byStatus.get(st)?.[field] || 0), 0);
  const sumPlants = (statuses) =>
    statuses.reduce((s, st) => s + (byStatus.get(st)?.plants || 0), 0);

  const activeOrders = sum(ACTIVE);
  const activeUnsowed = ACTIVE.reduce((s, st) => s + (byStatus.get(st)?.unsowed || 0), 0);
  const activeUnsowedPlants = ACTIVE.reduce(
    (s, st) => s + (byStatus.get(st)?.unsowedPlants || 0),
    0
  );
  const dispatchedOrders = sum(["DISPATCHED"]);
  const completedOrders = sum(["COMPLETED"]);
  const readyDispatchOrders = sum(READY_DISPATCH);
  const readyDispatchUnsowed = READY_DISPATCH.reduce(
    (s, st) => s + (byStatus.get(st)?.unsowed || 0),
    0
  );

  const sowingPending = await Order.countDocuments({
    ...baseMatch,
    orderStatus: { $in: ACTIVE },
    sowingDone: { $ne: true },
  });
  const sowingPendingPlants = await Order.aggregate([
    {
      $match: {
        ...baseMatch,
        orderStatus: { $in: ACTIVE },
        sowingDone: { $ne: true },
      },
    },
    {
      $group: {
        _id: null,
        p: {
          $sum: {
            $add: [
              { $ifNull: ["$numberOfPlants", 0] },
              { $ifNull: ["$additionalPlants", 0] },
            ],
          },
        },
      },
    },
  ]);

  const sowingDoneCount = await Order.countDocuments({
    ...baseMatch,
    sowingDone: true,
    orderStatus: { $nin: ["CANCELLED", "REJECTED", "TEMPORARY_CANCELLED"] },
  });

  console.log("\n── Buckets (active pipeline) ──");
  console.log(`Active orders (not cancelled/rejected):     ${activeOrders} orders · ${fmt(sumPlants(ACTIVE))} plants`);
  console.log(`  └ sowing NOT done (need sow):             ${sowingPending} orders · ${fmt(sowingPendingPlants[0]?.p || 0)} plants`);
  console.log(`  └ sowingDone = true:                      ${sowingDoneCount} orders`);
  console.log(`Ready for dispatch (FARM_READY/RFD/PROC):   ${readyDispatchOrders} orders · ${fmt(sumPlants(READY_DISPATCH))} plants (${readyDispatchUnsowed} unsowed)`);
  console.log(`Dispatched:                                 ${dispatchedOrders} orders · ${fmt(sumPlants(["DISPATCHED"]))} plants`);
  console.log(`Completed:                                  ${completedOrders} orders · ${fmt(sumPlants(["COMPLETED"]))} plants`);

  // By plant + subtype
  const bySubtype = await Order.aggregate([
    { $match: baseMatch },
    {
      $group: {
        _id: { plant: "$plantName", subtype: "$plantSubtype", status: "$orderStatus" },
        orders: { $sum: 1 },
        plants: {
          $sum: {
            $add: [
              { $ifNull: ["$numberOfPlants", 0] },
              { $ifNull: ["$additionalPlants", 0] },
            ],
          },
        },
        unsowed: {
          $sum: { $cond: [{ $ne: ["$sowingDone", true] }, 1, 0] },
        },
      },
    },
    { $sort: { "_id.plant": 1, "_id.subtype": 1, "_id.status": 1 } },
  ]);

  console.log("\n── By plant / subtype (top unsowed active) ──");
  const subtypeRoll = new Map();
  for (const r of bySubtype) {
    const key = `${r._id.plant}-${r._id.subtype}`;
    const meta = subtypeMap.get(String(r._id.subtype)) || {};
    if (!subtypeRoll.has(key)) {
      subtypeRoll.set(key, {
        plant: meta.plantName || String(r._id.plant),
        subtype: meta.subtypeName || String(r._id.subtype),
        orders: 0,
        plants: 0,
        unsowed: 0,
        dispatched: 0,
        ready: 0,
      });
    }
    const row = subtypeRoll.get(key);
    row.orders += r.orders;
    row.plants += r.plants;
    if (ACTIVE.includes(r._id.status)) row.unsowed += r.unsowed;
    if (r._id.status === "DISPATCHED") row.dispatched += r.orders;
    if (READY_DISPATCH.includes(r._id.status)) row.ready += r.orders;
  }

  const sorted = [...subtypeRoll.values()].sort((a, b) => b.unsowed - a.unsowed);
  console.log(
    "Plant".padEnd(14) +
      "Subtype".padEnd(18) +
      "Orders".padStart(7) +
      "Plants".padStart(11) +
      "Unsowed".padStart(8) +
      "Ready".padStart(7) +
      "Disp".padStart(6)
  );
  console.log("-".repeat(72));
  for (const r of sorted.slice(0, 25)) {
    console.log(
      r.plant.padEnd(14) +
        r.subtype.padEnd(18) +
        String(r.orders).padStart(7) +
        fmt(r.plants).padStart(11) +
        String(r.unsowed).padStart(8) +
        String(r.ready).padStart(7) +
        String(r.dispatched).padStart(6)
    );
  }

  // Seed source breakdown for unsowed active
  const seedBreak = await Order.aggregate([
    {
      $match: {
        ...baseMatch,
        orderStatus: { $in: ACTIVE },
        sowingDone: { $ne: true },
      },
    },
    {
      $group: {
        _id: { $ifNull: ["$sowingPlan.seedSource", "COMPANY"] },
        orders: { $sum: 1 },
        plants: {
          $sum: {
            $add: [
              { $ifNull: ["$numberOfPlants", 0] },
              { $ifNull: ["$additionalPlants", 0] },
            ],
          },
        },
      },
    },
  ]);

  console.log("\n── Pending sow · by seed source ──");
  for (const r of seedBreak) {
    console.log(`  ${r._id}: ${r.orders} orders · ${fmt(r.plants)} plants`);
  }

  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

/**
 * Verify Out (dispatched) MIS counts vs drawer and report legacy vs statusChanges-only.
 *
 *   node scripts/verify-mis-out.mjs
 *   node scripts/verify-mis-out.mjs 2026-04-28 2026-05-27
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import mongoose from "mongoose";
import Order from "../models/order.model.js";
import { fetchAdminDailyMis } from "../services/adminDailyMis.service.js";
import { fetchAdminMisOrders } from "../services/adminMisOrders.service.js";
import { aggregateTransitionsByDay } from "../utility/adminMisMetrics.js";
import {
  LINE_PLANT_TOTAL_ADD_FIELDS,
  orderStatusExcludeMatch,
  getIstTodayYmd,
} from "../utility/istOrderDateStats.js";
import moment from "moment";

const IST = "Asia/Kolkata";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "../.env") });

const uri = process.env.MONGO_URL || process.env.PROD_MONGO_URL || process.env.STAGE_MONGO_URL;

/** Old rule: statusChanges only (no legacy updatedAt). */
async function countDispatchedStatusChangesOnly(rangeStart, rangeEnd) {
  const statusMatch = orderStatusExcludeMatch();
  const rows = await Order.aggregate([
    { $match: statusMatch },
    { $addFields: LINE_PLANT_TOTAL_ADD_FIELDS },
    { $unwind: "$statusChanges" },
    {
      $match: {
        "statusChanges.newStatus": "DISPATCHED",
        "statusChanges.createdAt": { $gte: rangeStart, $lte: rangeEnd },
      },
    },
    {
      $group: {
        _id: { orderId: "$_id" },
        plants: { $first: "$linePlantTotal" },
      },
    },
    { $group: { _id: null, orders: { $sum: 1 }, plants: { $sum: "$plants" } } },
  ]);
  return {
    orders: rows[0]?.orders ?? 0,
    plants: rows[0]?.plants ?? 0,
  };
}

function sumDispatchedByDayMap(dayMap) {
  let orders = 0;
  let plants = 0;
  for (const v of dayMap.values()) {
    orders += v.orders || 0;
    plants += v.plants || 0;
  }
  return { orders, plants };
}

async function main() {
  if (!uri) {
    console.error("No MONGO_URL in .env — set MONGO_URL to run live Out verification.");
    process.exit(1);
  }

  const endYmd = process.argv[2] || getIstTodayYmd();
  const startYmd =
    process.argv[3] ||
    moment(endYmd, "YYYY-MM-DD").utcOffset(330).subtract(30, "days").format("YYYY-MM-DD");

  await mongoose.connect(uri);

  try {
    const parsed = await import("../utility/istOrderDateStats.js").then((m) =>
      m.parseYmdRange(startYmd, endYmd)
    );
    if (parsed.error) {
      console.error(parsed.error);
      process.exit(1);
    }
    const { rangeStart, rangeEnd } = parsed;

    console.log(`\n=== Out (dispatched) verification: ${startYmd} → ${endYmd} ===\n`);

    const [mis, legacyOnly, newByDay] = await Promise.all([
      fetchAdminDailyMis(startYmd, endYmd),
      countDispatchedStatusChangesOnly(rangeStart, rangeEnd),
      aggregateTransitionsByDay("DISPATCHED", rangeStart, rangeEnd, orderStatusExcludeMatch()),
    ]);

    if (mis.error) {
      console.error("MIS error:", mis.error);
      process.exit(1);
    }

    const misOut = mis.data?.totals?.delivery?.dispatched ?? { orders: 0, plants: 0 };
    const aggOut = sumDispatchedByDayMap(newByDay);

    console.log("Counts (orders / plants):");
    console.log(`  MIS footer Out:              ${misOut.orders} / ${misOut.plants}`);
    console.log(`  aggregateTransitionsByDay:   ${aggOut.orders} / ${aggOut.plants}`);
    console.log(`  statusChanges-only (old):    ${legacyOnly.orders} / ${legacyOnly.plants}`);
    console.log(
      `  Legacy uplift:               +${aggOut.orders - legacyOnly.orders} orders, +${aggOut.plants - legacyOnly.plants} plants`
    );

    if (misOut.orders !== aggOut.orders) {
      console.error("\n✗ MIS footer Out does not match aggregateTransitionsByDay sum");
      process.exit(1);
    }

    const days = (mis.data?.days || []).filter((d) => d.date && d.date !== "past-due");
    let tested = 0;
    let passed = 0;
    let failed = 0;

    console.log("\nPer-day drawer vs MIS Out:");
    for (const day of days) {
      const expected = day.delivery?.dispatched?.orders ?? 0;
      if (expected === 0) continue;

      tested++;
      const drawer = await fetchAdminMisOrders({
        date: day.date,
        bucket: "dispatched",
        mode: "delivery",
        page: 1,
        limit: 500,
      });
      const actual = drawer.data?.total ?? 0;
      const ok = actual === expected;
      if (ok) {
        passed++;
        console.log(`  ✓ ${day.date}: MIS=${expected} drawer=${actual}`);
      } else {
        failed++;
        console.log(`  ✗ ${day.date}: MIS=${expected} drawer=${actual}`);
      }
    }

    const sumPerDay = days.reduce(
      (n, d) => n + (d.delivery?.dispatched?.orders ?? 0),
      0
    );
    if (misOut.orders > 0) {
      tested++;
      if (misOut.orders === sumPerDay) {
        passed++;
        console.log(
          `  ✓ footer Out=${misOut.orders} matches sum of daily cells (transition events)`
        );
      } else {
        failed++;
        console.log(
          `  ✗ footer=${misOut.orders} vs sum daily cells=${sumPerDay}`
        );
      }

      tested++;
      const rangeDrawer = await fetchAdminMisOrders({
        startDate: startYmd,
        endDate: endYmd,
        bucket: "dispatched",
        mode: "delivery",
        page: 1,
        limit: 1,
      });
      const uniqueOrders = rangeDrawer.data?.total ?? 0;
      console.log(
        `  ℹ unique orders in range (drawer total): ${uniqueOrders} — can be less than footer when same order dispatched on multiple days`
      );
      if (uniqueOrders <= sumPerDay) {
        passed++;
      } else {
        failed++;
        console.log(`  ✗ drawer unique orders ${uniqueOrders} > event sum ${sumPerDay}`);
      }
    }

    console.log(`\n--- Out test: ${passed}/${tested} checks passed ---\n`);

    if (failed > 0) process.exit(1);
    if (misOut.orders === 0 && legacyOnly.orders === 0) {
      console.log("No Out activity in range — try a wider range or check data.");
    } else if (aggOut.orders > legacyOnly.orders) {
      console.log("Out counts include legacy updatedAt fallback (statusChanges-only was lower).");
    } else {
      console.log("Out counts OK.");
    }
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

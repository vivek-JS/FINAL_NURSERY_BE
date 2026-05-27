/**
 * Compare MIS table counts vs admin-mis-orders drawer totals for a date range.
 *   node scripts/verify-mis-drawer-counts.mjs
 *   node scripts/verify-mis-drawer-counts.mjs 2026-05-01 2026-05-07
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import mongoose from "mongoose";
import { fetchAdminDailyMis } from "../services/adminDailyMis.service.js";
import { fetchAdminMisOrders } from "../services/adminMisOrders.service.js";
import { getIstTodayYmd } from "../utility/istOrderDateStats.js";
import moment from "moment";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "../.env") });

const uri = process.env.MONGO_URL || process.env.PROD_MONGO_URL || process.env.STAGE_MONGO_URL;

const BUCKETS = [
  { bucket: "booking", mode: "booking", getCount: (day) => day.booking },
  { bucket: "accepted", mode: "delivery", getCount: (day) => day.delivery?.accepted },
  { bucket: "farmReady", mode: "delivery", getCount: (day) => day.delivery?.farmReady },
  { bucket: "readyForDispatch", mode: "delivery", getCount: (day) => day.delivery?.readyForDispatch },
  { bucket: "dispatched", mode: "delivery", getCount: (day) => day.delivery?.dispatched },
  { bucket: "deliveryTotal", mode: "delivery", getCount: (day) => day.delivery?.total },
];

async function main() {
  if (!uri) {
    console.error("No MONGO_URL in .env — cannot run live DB test.");
    process.exit(1);
  }

  const endYmd = process.argv[2] || getIstTodayYmd();
  const startYmd =
    process.argv[3] ||
    moment(endYmd, "YYYY-MM-DD").utcOffset(330).subtract(6, "days").format("YYYY-MM-DD");

  await mongoose.connect(uri);

  try {
    console.log(`\nMIS drawer count verification: ${startYmd} → ${endYmd}\n`);

    const mis = await fetchAdminDailyMis(startYmd, endYmd);
    if (mis.error) {
      console.error("MIS fetch failed:", mis.error);
      process.exit(1);
    }

    const days = (mis.data?.days || []).filter((d) => d.date && d.date !== "past-due");
    let tested = 0;
    let passed = 0;
    let failed = 0;
    const failures = [];

    for (const day of days) {
      for (const { bucket, mode, getCount } of BUCKETS) {
        const metric = getCount(day);
        const expectedOrders = metric?.orders ?? 0;
        if (expectedOrders === 0) continue;

        tested++;
        const ordersRes = await fetchAdminMisOrders({
          date: day.date,
          bucket,
          mode,
          page: 1,
          limit: 500,
        });

        if (ordersRes.error) {
          failed++;
          failures.push({ day: day.date, bucket, issue: ordersRes.error });
          continue;
        }

        const actual = ordersRes.data?.total ?? ordersRes.data?.data?.length ?? 0;
        const ok = actual === expectedOrders;
        if (ok) {
          passed++;
          console.log(`  ✓ ${day.date} ${bucket}: MIS=${expectedOrders} drawer=${actual}`);
        } else {
          failed++;
          failures.push({
            day: day.date,
            bucket,
            expected: expectedOrders,
            actual,
            plantsMis: metric?.plants,
          });
          console.log(`  ✗ ${day.date} ${bucket}: MIS=${expectedOrders} drawer=${actual}`);
        }
      }
    }

    // Footer totals: farmReady (global) for full range
    const totals = mis.data?.totals;
    if (totals?.delivery?.farmReady?.orders > 0) {
      tested++;
      const res = await fetchAdminMisOrders({
        startDate: startYmd,
        endDate: endYmd,
        bucket: "farmReady",
        mode: "delivery",
        limit: 500,
      });
      const actual = res.data?.total ?? 0;
      const expected = totals.delivery.farmReady.orders;
      if (actual === expected) {
        passed++;
        console.log(`  ✓ range farmReady: MIS=${expected} drawer=${actual}`);
      } else {
        failed++;
        failures.push({ day: "range", bucket: "farmReady", expected, actual });
        console.log(`  ✗ range farmReady: MIS=${expected} drawer=${actual}`);
      }
    }

    console.log(`\n--- Result: ${passed}/${tested} passed, ${failed} failed ---\n`);

    if (failed > 0) {
      console.log("Failures:", JSON.stringify(failures, null, 2));
      process.exit(1);
    }

    if (tested === 0) {
      console.log("No non-zero cells in range — try a wider date range.");
    } else {
      console.log("FIX VERIFIED: drawer order counts match MIS table counts.");
    }
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

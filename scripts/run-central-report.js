/**
 * Central report engine CLI — run any registered MIS report from the terminal.
 *
 *   node scripts/run-central-report.js list
 *   node scripts/run-central-report.js admin-daily-mis 2026-05-01 2026-05-07
 *   node scripts/run-central-report.js sales 2026-05-01 2026-05-07 --due-only
 *   node scripts/run-central-report.js due 2026-05-01 2026-05-07 --include-all-past-due
 *   node scripts/run-central-report.js daily 2026-05-01 2026-05-07 --json > out.json
 *
 * Env: MONGO_URL or PROD_MONGO_URL in FINAL_NURSERY_BE/.env
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import mongoose from "mongoose";
import {
  runCentralReport,
  listCentralReports,
  getCentralReportEngineMeta,
} from "../utility/centralReportEngine/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "../.env") });

const argv = process.argv.slice(2);

function parseFlags(args) {
  const flags = {
    dueOnly: args.includes("--due-only"),
    includeAllPastDue: args.includes("--include-all-past-due"),
    json: args.includes("--json"),
    meta: args.includes("--meta"),
  };
  return flags;
}

function printList() {
  const meta = getCentralReportEngineMeta();
  console.log("Central report engine\n");
  console.log(`Timezone: ${meta.timezone}\n`);
  console.log("Reports:");
  for (const r of meta.reports) {
    console.log(`  ${r.id}`);
    console.log(`    ${r.title}`);
    console.log(`    ${r.apiPath}`);
    if (r.aliases?.length) console.log(`    aliases: ${r.aliases.join(", ")}`);
    console.log("");
  }
  console.log("Metric columns:", Object.keys(meta.metricRules).join(", "));
}

async function main() {
  if (!argv.length || argv[0] === "help" || argv[0] === "--help") {
    console.log(`Usage:
  node scripts/run-central-report.js list
  node scripts/run-central-report.js <report-id> <startDate> <endDate> [--due-only] [--include-all-past-due] [--json] [--meta]

Examples:
  node scripts/run-central-report.js daily 2026-05-01 2026-05-07
  node scripts/run-central-report.js admin-mis-sales 2026-05-01 2026-05-07 --json`);
    process.exit(0);
  }

  if (argv[0] === "list") {
    printList();
    process.exit(0);
  }

  const reportId = argv[0];
  const startDate = argv[1];
  const endDate = argv[2];
  const flags = parseFlags(argv.slice(3));

  if (!startDate || !endDate) {
    console.error("Provide startDate and endDate (YYYY-MM-DD).");
    process.exit(1);
  }

  const uri =
    process.env.MONGO_URL ||
    process.env.PROD_MONGO_URL ||
    process.env.STAGE_MONGO_URL;
  if (!uri) {
    console.error("No MONGO_URL in .env");
    process.exit(1);
  }

  await mongoose.connect(uri);
  try {
    const result = await runCentralReport(reportId, startDate, endDate, {
      dueOnly: flags.dueOnly,
      includeAllPastDue: flags.includeAllPastDue,
    });

    if (result.error) {
      console.error(result.error);
      console.error("\nKnown reports:", listCentralReports().map((r) => r.id).join(", "));
      process.exit(1);
    }

    if (flags.json) {
      const out = flags.meta
        ? {
            reportId: result.reportId,
            reportTitle: result.reportTitle,
            layout: result.layout,
            data: result.data,
          }
        : result.data;
      console.log(JSON.stringify(out, null, 2));
    } else {
      console.log(`Report: ${result.reportTitle} (${result.reportId})`);
      console.log(`Layout: ${result.layout}`);
      const d = result.data;
      if (d?.days) {
        console.log(`Days: ${d.days.length}, range ${d.startDate} – ${d.endDate}`);
        const t = d.totals;
        if (t?.booking) {
          console.log(
            `Totals booking: ${t.booking.orders} orders / ${t.booking.plants} plants`
          );
        }
        if (t?.delivery?.total) {
          console.log(
            `Totals delivery union: ${t.delivery.total.orders} orders / ${t.delivery.total.plants} plants`
          );
        }
        if (t?.delivery?.farmReady) {
          console.log(
            `Totals farm ready (global): ${t.delivery.farmReady.orders} / ${t.delivery.farmReady.plants}`
          );
        }
      } else if (d?.rows) {
        console.log(`Rows: ${d.rows.length}`);
        if (d.totals?.booking) {
          console.log(
            `Totals booking: ${d.totals.booking.orders} / ${d.totals.booking.plants}`
          );
        }
      }
      console.log("\nUse --json for full payload.");
    }
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

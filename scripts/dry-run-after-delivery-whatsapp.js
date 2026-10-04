/**
 * Preview or send after_delivery WATI for completed dispatches (yesterday + day before, IST).
 *
 *   node scripts/dry-run-after-delivery-whatsapp.js              # dry-run, last 2 days
 *   node scripts/dry-run-after-delivery-whatsapp.js --send     # actually send WATI
 *   node scripts/dry-run-after-delivery-whatsapp.js --days=3     # wider window
 */
import mongoose from "mongoose";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { runAfterDeliveryBatch } from "../services/afterDeliveryWhatsapp.service.js";
import "../models/farmer.model.js";
import "../models/plantCms.model.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "../.env") });

function parseArgs(argv) {
  let dryRun = true;
  let daysBack = 2;
  let endDaysAgo = 1;
  for (const arg of argv) {
    if (arg === "--send") dryRun = false;
    else if (arg.startsWith("--days=")) daysBack = Number(arg.split("=")[1]) || 2;
    else if (arg.startsWith("--endDaysAgo=")) endDaysAgo = Number(arg.split("=")[1]) || 1;
  }
  return { dryRun, daysBack, endDaysAgo, allowPending: !dryRun };
}

async function main() {
  const { dryRun, daysBack, endDaysAgo, allowPending } = parseArgs(process.argv.slice(2));
  const uri = process.env.MONGO_URL || process.env.MONGODB_URI;
  if (!uri) throw new Error("Set MONGO_URL");

  await mongoose.connect(uri);
  const result = await runAfterDeliveryBatch({ daysBack, dryRun, endDaysAgo, allowPending });

  console.log(JSON.stringify(result, null, 2));
  console.log("\n--- MESSAGE PREVIEWS ---");
  for (const d of result.dispatches) {
    for (const m of d.messages || []) {
      console.log("\n---");
      console.log(
        `Vehicle ${d.vehicleNumber || "—"} | Transport ${d.transportId || "—"} | Status ${d.transportStatus || "—"} | Order ${m.orderNumber} | ${m.farmerName} | ${m.phone || "NO PHONE"}`
      );
      if (m.skipped) console.log(`SKIPPED: ${m.skipReason || m.reason}`);
      else if (m.success) console.log(m.preview || "SENT OK");
      else console.log(`FAILED: ${m.error || "unknown"}`);
    }
  }

  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

/**
 * Remove completed sowing request + reverse slot batches.
 *
 *   node scripts/dry-run-remove-sow-entry.mjs --prod SR202607280001
 *   node scripts/dry-run-remove-sow-entry.mjs --prod --apply SR202607280001
 */
import mongoose from "mongoose";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import SowingRequest from "../models/sowingRequest.model.js";
import Order from "../models/order.model.js";
import {
  findSowBatchForRequest,
  reverseSowBatchFromSlot,
} from "../controllers/sowingCompleteHelpers.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "..", ".env") });

const args = process.argv.slice(2);
const prod = args.includes("--prod");
const apply = args.includes("--apply");
const requestNumber = args.find((a) => !a.startsWith("--"));

if (!requestNumber) {
  console.error("Usage: node scripts/dry-run-remove-sow-entry.mjs --prod [--apply] SR202607280001");
  process.exit(1);
}

const uri = prod
  ? process.env.PROD_MONGO_URL
  : process.env.STAGE_MONGO_URL || process.env.MONGO_URL;
if (!uri) {
  console.error("Missing Mongo URI");
  process.exit(1);
}

function fmt(n) {
  return Number(n || 0).toLocaleString("en-IN");
}

function batchReversePlan(batch, qty) {
  const covered = Math.max(0, Number(batch?.orderCoveredPlants) || 0);
  const excess = Math.max(
    0,
    Number(batch?.excessPlants) ||
      (batch?.isExcessiveSowing ? qty : 0) ||
      0
  );
  const saleableRev = batch?.isExcessiveSowing ? qty : excess > 0 ? excess : 0;
  return {
    primarySowed: -qty,
    totalPlants: -qty,
    plantsSowed: -qty,
    availablePlants: saleableRev > 0 ? -saleableRev : 0,
    excessiveSowingPlants: saleableRev > 0 ? -saleableRev : 0,
    orderReservedPlants: covered > 0 ? -covered : 0,
    covered,
    excess: saleableRev,
  };
}

async function main() {
  console.log(`\n=== ${apply ? "APPLY" : "DRY RUN"} remove sow entry ===`);
  console.log(`DB: ${prod ? "PRODUCTION" : "stage/dev"}`);
  console.log(`Request: ${requestNumber}\n`);

  await mongoose.connect(uri);

  const request = await SowingRequest.findOne({ requestNumber }).lean();
  if (!request) {
    console.error("SowingRequest not found:", requestNumber);
    process.exit(1);
  }

  console.log("--- SowingRequest ---");
  console.log({
    _id: String(request._id),
    requestNumber: request.requestNumber,
    plantName: request.plantName,
    subtypeName: request.subtypeName,
    sowedQuantity: request.sowedQuantity,
    packetsUsed: request.packetsUsed,
    sowingCompleted: request.sowingCompleted,
  });

  const reqId = request._id;
  const batchRows = await findSowBatchForRequest(reqId);

  if (!batchRows.length) {
    console.log("\n⚠ No sowingBatches on slots for this request.");
  } else {
    console.log(`\n--- Slot batches (${batchRows.length}) ---`);
    for (const row of batchRows) {
      const b = row.batch;
      const qty = Number(b?.plantsSowed) || 0;
      const plan = batchReversePlan(b, qty);
      console.log("\nSlot:", `${row.startDay} – ${row.endDay}`, `(${row.slotId})`);
      console.log("  Batch plants:", qty, "packets:", b?.packetsUsed);
      console.log("  Would reverse:", plan);
    }
  }

  const linkedOrders = await Order.find({
    $or: [{ sowingDoneRequestId: reqId }, { _id: { $in: request.linkedOrderIds || [] } }],
  })
    .select("orderId name numberOfPlants additionalPlants deliveryDate sowingDone sowingDoneRequestId")
    .lean();

  const toUnmark = linkedOrders.filter(
    (o) => o.sowingDone && String(o.sowingDoneRequestId) === String(reqId)
  );
  console.log(`\nOrders linked: ${linkedOrders.length}, would unmark sowingDone: ${toUnmark.length}`);

  if (!apply) {
    console.log("\n✓ DRY RUN complete — no changes written.");
    console.log("Re-run with --apply to execute.\n");
    await mongoose.disconnect();
    return;
  }

  console.log("\n--- APPLYING REMOVAL ---");
  for (const row of batchRows) {
    const qty = Number(row.batch?.plantsSowed) || 0;
    const r = await reverseSowBatchFromSlot(row.slotId, reqId, qty);
    console.log(`Reversed slot ${row.startDay}: ${r.reversed} plants`);
  }

  if (toUnmark.length) {
    const res = await Order.updateMany(
      { _id: { $in: toUnmark.map((o) => o._id) } },
      {
        $set: { sowingDone: false },
        $unset: { sowingDoneAt: "", sowingDoneRequestId: "" },
      }
    );
    console.log(`Unmarked sowingDone on ${res.modifiedCount} order(s)`);
  }

  await SowingRequest.deleteOne({ _id: reqId });
  console.log(`Deleted SowingRequest ${requestNumber}`);

  console.log("\n✓ APPLY complete.\n");
  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

/**
 * Undo a mistaken "cover order from excess" on PROD without cancelling the order:
 * plants go back to the source excess batch, order → not sowed, cover audit request cancelled.
 *
 *   node scripts/reverse-order-excess-cover-prod.mjs           # dry-run
 *   node scripts/reverse-order-excess-cover-prod.mjs --apply   # write PROD
 */
import mongoose from "mongoose";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import Order from "../models/order.model.js";
import SowingRequest from "../models/sowingRequest.model.js";
import { reverseOrderBatchCover } from "../services/orderExcessBatchCover.service.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "..", ".env") });

const APPLY = process.argv.includes("--apply");
const ORDER_IDS = [4098];
const ADMIN_ID = new mongoose.Types.ObjectId("69c74937ac73e9c36b673925");

async function slotSnapshot(slotId) {
  const oid = new mongoose.Types.ObjectId(slotId);
  const [row] = await mongoose.connection.db
    .collection("plantslots")
    .aggregate([
      { $match: { "subtypeSlots.slots._id": oid } },
      { $unwind: "$subtypeSlots" },
      { $unwind: "$subtypeSlots.slots" },
      { $match: { "subtypeSlots.slots._id": oid } },
      { $replaceRoot: { newRoot: "$subtypeSlots.slots" } },
    ])
    .toArray();
  if (!row) return "— slot not found —";
  const batches = (row.sowingBatches || []).map(
    (b) => `${b.requestNumber || "?"}:${b.plantsSowed}/ex ${b.excessPlants ?? 0}/av ${b.availablePlantsApplied ?? 0}`
  );
  return `${row.startDay} · sowed ${row.plantsSowed} · actual ${row.actualPlants} · avail ${row.availablePlants} · excess ${row.excessiveSowing?.plants ?? 0} · reserved ${row.orderReservedPlants ?? 0} · batches [${batches.join(", ")}]`;
}

async function main() {
  console.log(APPLY ? "APPLY reverse excess cover — PROD\n" : "DRY-RUN reverse excess cover — PROD\n");
  await mongoose.connect(process.env.PROD_MONGO_URL);

  for (const orderId of ORDER_IDS) {
    console.log("─".repeat(70));
    const order = await Order.findOne({ orderId }).lean();
    if (!order) {
      console.log(`#${orderId}: NOT FOUND`);
      continue;
    }
    const sources = order.sowingCoverSources || [];
    const active = sources.length && !order.sowingCoverReversedAt;
    console.log(
      `#${orderId} · status ${order.orderStatus} · plants ${order.numberOfPlants} · sowingDone ${order.sowingDone} · cover ${active ? "ACTIVE" : "none/reversed"}`
    );
    for (const s of sources) {
      console.log(
        `  source ${s.requestNumber} · ${s.plants} plants · sow ${s.sowingDate} · ready ${s.plantReadyDate} · moved ${s.moved}`
      );
      console.log(`    source slot: ${await slotSnapshot(s.slotId)}`);
      if (s.destSlotId) console.log(`    dest slot:   ${await slotSnapshot(s.destSlotId)}`);
    }
    const coverReq = order.sowingDoneRequestId
      ? await SowingRequest.findById(order.sowingDoneRequestId)
      : null;
    if (coverReq) {
      console.log(
        `  cover request ${coverReq.requestNumber} · ${coverReq.status} · completed ${coverReq.sowingCompleted} · ${coverReq.sowedQuantity} · "${coverReq.notes}"`
      );
    }

    if (!active) {
      console.log("Nothing to reverse — skip");
      continue;
    }
    if (coverReq && !/cover order from excess/i.test(coverReq.notes || "")) {
      console.log("sowingDoneRequestId is not a cover audit request — skip");
      continue;
    }
    if (!APPLY) continue;

    const session = await mongoose.startSession();
    let result;
    try {
      await session.withTransaction(async () => {
        const fresh = await Order.findById(order._id).session(session).lean();
        result = await reverseOrderBatchCover({ order: fresh, userId: ADMIN_ID, session });
      });
    } finally {
      await session.endSession();
    }
    console.log(`REVERSED · ${result?.plants || 0} plants · sources ${result?.sources || 0}`);

    if (coverReq) {
      for (const ev of coverReq.completionEvents || []) {
        if (ev.type === "SOW_COMPLETED" || ev.type === "PLANTS_SOWED") {
          ev.meta = { ...(ev.meta || {}), reversedFromType: ev.type, reversedAt: new Date() };
          ev.message = `[Reversed] ${ev.message || ""}`.trim();
          ev.type = "NOTE";
        }
      }
      coverReq.completionEvents.push({
        type: "NOTE",
        at: new Date(),
        by: ADMIN_ID,
        quantity: coverReq.sowedQuantity,
        unit: "plants",
        message: `Excess cover reversed for order #${orderId} — marked by mistake; plants returned to source batches`,
      });
      coverReq.markModified("completionEvents");
      coverReq.status = "cancelled";
      coverReq.sowingCompleted = false;
      coverReq.cancelledBy = ADMIN_ID;
      coverReq.cancelledDate = new Date();
      coverReq.cancellationReason = `Excess cover for order #${orderId} done by mistake — reversed`;
      await coverReq.save();
      console.log(`Cover request ${coverReq.requestNumber} cancelled`);
    }

    const after = await Order.findById(order._id)
      .select("sowingDone sowingDoneRequestId sowingCoverReversedAt")
      .lean();
    console.log(`Order now · sowingDone ${after.sowingDone} · coverReversedAt ${after.sowingCoverReversedAt?.toISOString()}`);
    for (const s of sources) {
      console.log(`    source slot: ${await slotSnapshot(s.slotId)}`);
      if (s.destSlotId) console.log(`    dest slot:   ${await slotSnapshot(s.destSlotId)}`);
    }
  }

  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

/**
 * SR202610240003 covered 102312 (gross). Mortality 12277 → actual 90035.
 * Re-FIFO from 90035: 4257 partial 13035, drop 4277's 7312 hold.
 *
 *   node scripts/fix-sr202610240003-cover-pool-prod.mjs
 *   node scripts/fix-sr202610240003-cover-pool-prod.mjs --apply
 */
import mongoose from "mongoose";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import Order from "../models/order.model.js";
import SowingRequest from "../models/sowingRequest.model.js";
import { sowCoverPool } from "../utility/lagwadSlotPlantsSplit.js";
import {
  planOrderSowCover,
  applyIncompleteRequestRelease,
} from "../services/orderSowCover.plan.js";
import { pushBatchChangeLog } from "../utility/sowingBatchChangeLog.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "..", ".env") });

const APPLY = process.argv.includes("--apply");
const REQ = "SR202610240003";

async function findBatch(rid) {
  const [row] = await mongoose.connection.db
    .collection("plantslots")
    .aggregate([
      { $match: { "subtypeSlots.slots.sowingBatches.sowingRequestId": rid } },
      { $unwind: "$subtypeSlots" },
      { $unwind: "$subtypeSlots.slots" },
      { $unwind: "$subtypeSlots.slots.sowingBatches" },
      {
        $match: {
          "subtypeSlots.slots.sowingBatches.sowingRequestId": rid,
        },
      },
      {
        $project: {
          slotId: "$subtypeSlots.slots._id",
          startDay: "$subtypeSlots.slots.startDay",
          reserved: "$subtypeSlots.slots.orderReservedPlants",
          avail: "$subtypeSlots.slots.availablePlants",
          batch: "$subtypeSlots.slots.sowingBatches",
        },
      },
    ])
    .toArray();
  return row;
}

async function main() {
  console.log(APPLY ? "APPLY cover-from-actual\n" : "DRY-RUN cover-from-actual\n");
  await mongoose.connect(process.env.PROD_MONGO_URL);
  const req = await SowingRequest.findOne({ requestNumber: REQ });
  if (!req) throw new Error("request not found");
  const rid = req._id;
  const sowed = Math.floor(Number(req.sowedQuantity) || 0);
  const pct = 12;
  const coverPool = sowCoverPool(sowed, pct);
  const ids = [
    ...new Set(
      [...(req.linkedOrderIds || []), ...(req.uncoveredOrderIds || [])].map(String)
    ),
  ];
  const orders = await Order.find({ _id: { $in: ids } })
    .select(
      "_id orderId numberOfPlants additionalPlants deliveryDate createdAt sowingDone sowingPartialCover leftoverFromIncomplete sowingDoneRequestId"
    )
    .sort({ deliveryDate: 1, createdAt: 1, orderId: 1 });
  const plan = planOrderSowCover({ plantsSowed: coverPool, orders });
  console.log(
    `${REQ} sowed ${sowed} mort ${Math.round((sowed * pct) / 100)} pool ${coverPool}`
  );
  console.log(
    `full ${plan.full.length} partial ${plan.partial?.addPlants || 0} on ${plan.partial?.orderId || "-"} waiting ${plan.waiting.length} covered ${plan.orderPlantsCovered}`
  );
  for (const o of orders) {
    const isFull = plan.full.some((f) => String(f.orderId) === String(o._id));
    const isPart = plan.partial && String(plan.partial.orderId) === String(o._id);
    const held = (o.sowingPartialCover || []).map(
      (p) => `${p.plants}@${p.requestId}`
    );
    console.log(
      `  #${o.orderId} ${o.numberOfPlants} done=${o.sowingDone} hold=[${held}] → ${
        isFull ? "FULL" : isPart ? `PARTIAL ${plan.partial.addPlants}` : "WAIT"
      }`
    );
  }
  const slotRow = await findBatch(rid);
  console.log(
    `slot ${slotRow?.startDay} reserved ${slotRow?.reserved} avail ${slotRow?.avail} batchCover ${slotRow?.batch?.orderCoveredPlants} shown ${slotRow?.batch?.shownExcess}`
  );

  if (!APPLY) {
    await mongoose.disconnect();
    return;
  }

  applyIncompleteRequestRelease(req, plan, { sowedAt: req.sowingCompletedDate || new Date() });
  const fullIds = plan.full.map((f) => f.orderId);
  await Order.updateMany(
    { _id: { $in: fullIds } },
    {
      $set: {
        sowingDone: true,
        leftoverFromIncomplete: false,
        sowingDoneRequestId: rid,
      },
    }
  );
  const leftoverIds = [
    plan.partial?.orderId,
    ...(plan.waiting || []).map((w) => w.orderId),
  ].filter(Boolean);
  for (const oid of leftoverIds) {
    await Order.updateOne(
      { _id: oid },
      {
        $set: { sowingDone: false, leftoverFromIncomplete: true },
        $unset: { sowingDoneRequestId: 1, sowingDoneAt: 1 },
        $pull: { sowingPartialCover: { requestId: rid } },
      }
    );
  }
  if (plan.partial?.orderId && plan.partial.addPlants > 0) {
    await Order.updateOne(
      { _id: plan.partial.orderId },
      {
        $push: {
          sowingPartialCover: {
            requestId: rid,
            plants: plan.partial.addPlants,
            at: req.sowingCompletedDate || new Date(),
          },
        },
      }
    );
  }
  req.markModified("linkedOrderIds");
  req.markModified("uncoveredOrderIds");
  const ev = (req.completionEvents || []).find(
    (e) => e.type === "ORDERS_MARKED_SOWED" || e.type === "SOW_COMPLETED"
  );
  if (ev?.meta) {
    ev.meta.orderCoveredPlants = coverPool;
    ev.meta.coverPool = coverPool;
    ev.meta.plantsSowed = sowed;
    req.markModified("completionEvents");
  }
  await req.save();

  if (slotRow?._id && slotRow.batch) {
    const batch = slotRow.batch;
    pushBatchChangeLog(batch, {
      kind: "COVER_POOL",
      plants: coverPool,
      coverBefore: batch.orderCoveredPlants,
      coverAfter: coverPool,
      excessBefore: batch.shownExcess,
      excessAfter: 0,
      reason: `Cover from actual ${coverPool} (sowed ${sowed} − mort 12%)`,
    });
    await mongoose.connection.db.collection("plantslots").updateOne(
      {
        _id: slotRow._id,
        "subtypeSlots.slots._id": slotRow.slotId,
        "subtypeSlots.slots.sowingBatches.sowingRequestId": rid,
      },
      {
        $set: {
          "subtypeSlots.$[st].slots.$[sl].sowingBatches.$[b].orderCoveredPlants":
            coverPool,
          "subtypeSlots.$[st].slots.$[sl].sowingBatches.$[b].excessPlants": 0,
          "subtypeSlots.$[st].slots.$[sl].sowingBatches.$[b].shownExcess": 0,
          "subtypeSlots.$[st].slots.$[sl].sowingBatches.$[b].sowingBufferPct": pct,
          "subtypeSlots.$[st].slots.$[sl].sowingBatches.$[b].changeLog":
            batch.changeLog,
        },
      },
      {
        arrayFilters: [
          { "st.slots._id": slotRow.slotId },
          { "sl._id": slotRow.slotId },
          { "b.sowingRequestId": rid },
        ],
      }
    );
  }

  console.log("applied");
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

/**
 * SR202610160003 (Ram papaya): cover gap + wrong ready slot.
 *
 * Batches only held 94k (cover 5k) while the request recorded 115k and
 * 24 orders (111.5k) were marked sown for Nov-ready — deliveries are Oct 21–25.
 *
 * Fix:
 *  1. Rebuild sow as 115000 plants with cover pool = sowed − 15% (97750)
 *  2. Re-FIFO linked orders from that pool
 *  3. Move sow date 16-10-2026 → 15-09-2026 (ready 15-10-2026, delivery window)
 *  4. Un-cancel the request
 *
 *   TZ=UTC node scripts/fix-sr202610160003-cover-and-sow-date-prod.mjs
 *   TZ=UTC node scripts/fix-sr202610160003-cover-and-sow-date-prod.mjs --apply
 */
import mongoose from "mongoose";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import Order from "../models/order.model.js";
import SowingRequest from "../models/sowingRequest.model.js";
import { sowCoverPool } from "../utility/lagwadSlotPlantsSplit.js";
import { excessFieldsForBatch } from "../utility/sowingBatchExcessStamp.js";
import {
  planOrderSowCover,
  applyIncompleteRequestRelease,
} from "../services/orderSowCover.plan.js";
import { editSowEntryOnSlots, pushEvent } from "../controllers/sowingCompleteHelpers.js";
import {
  parseLocalDate,
  fmtDDMMYYYY,
  addDays,
} from "../controllers/sowingSlotReadyHelpers.js";
import { pushBatchChangeLog } from "../utility/sowingBatchChangeLog.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "..", ".env") });

const APPLY = process.argv.includes("--apply");
const REQ = "SR202610160003";
const NEW_SOW_YMD = "2026-09-15";
const BUFFER_PCT = 15;
const TARGET_SOWED = 115000;

async function findBatches(rid) {
  return mongoose.connection.db
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
          docId: "$_id",
          subtypeId: "$subtypeSlots.subtypeId",
          slotId: "$subtypeSlots.slots._id",
          startDay: "$subtypeSlots.slots.startDay",
          endDay: "$subtypeSlots.slots.endDay",
          reserved: "$subtypeSlots.slots.orderReservedPlants",
          sowed: "$subtypeSlots.slots.plantsSowed",
          batch: "$subtypeSlots.slots.sowingBatches",
        },
      },
    ])
    .toArray();
}

async function main() {
  if (process.env.TZ !== "UTC") {
    throw new Error("Run with TZ=UTC");
  }
  console.log(APPLY ? "APPLY cover + sow-date fix — PROD\n" : "DRY-RUN cover + sow-date fix — PROD\n");

  await mongoose.connect(process.env.PROD_MONGO_URL || process.env.MONGO_URL);
  const admin = await mongoose.connection.db.collection("users").findOne({
    _id: new mongoose.Types.ObjectId("69c74937ac73e9c36b673925"),
  });
  if (!admin) throw new Error("Admin user not found");

  const req = await SowingRequest.findOne({ requestNumber: REQ });
  if (!req) throw new Error(`${REQ} not found`);
  const rid = req._id;

  const coverPool = sowCoverPool(TARGET_SOWED, BUFFER_PCT);
  const excessAfter = Math.max(0, TARGET_SOWED - coverPool);
  const rows = await findBatches(rid);
  const orders = await Order.find({
    _id: {
      $in: [
        ...new Set(
          [...(req.linkedOrderIds || []), ...(req.uncoveredOrderIds || [])].map(String)
        ),
      ],
    },
  })
    .select(
      "_id orderId numberOfPlants additionalPlants deliveryDate createdAt sowingDone sowingPartialCover leftoverFromIncomplete sowingDoneRequestId"
    )
    .sort({ deliveryDate: 1, createdAt: 1, orderId: 1 });

  const plan = planOrderSowCover({ plantsSowed: coverPool, orders });
  const newSow = parseLocalDate(NEW_SOW_YMD);
  const newReady = fmtDDMMYYYY(addDays(newSow, 30));

  console.log(`${REQ} status=${req.status} sowedQty=${req.sowedQuantity}`);
  console.log(
    `Target sow ${TARGET_SOWED} · buffer ${BUFFER_PCT}% · coverPool ${coverPool} · excess ${excessAfter}`
  );
  console.log(
    `Order plan: covered ${plan.orderPlantsCovered} · full ${plan.full.length} · partial ${
      plan.partial?.addPlants || 0
    } · waiting ${plan.waiting.length}`
  );
  console.log(`Sow date → ${NEW_SOW_YMD} · ready → ${newReady}`);
  for (const row of rows) {
    console.log(
      `  batch now: slot ${row.startDay}–${row.endDay} · sow ${row.batch.sowingDate} · ready ${row.batch.plantReadyDate} · sowed ${row.batch.plantsSowed} · cover ${row.batch.orderCoveredPlants} · shown ${row.batch.shownExcess}`
    );
  }

  if (!APPLY) {
    await mongoose.disconnect();
    return;
  }

  // Patch batches so editSowEntryOnSlots aggregates the right cover/excess split.
  let coverLeft = coverPool;
  let excessLeft = excessAfter;
  // Prefer putting cover on the largest batch first.
  const sorted = [...rows].sort(
    (a, b) => (Number(b.batch.plantsSowed) || 0) - (Number(a.batch.plantsSowed) || 0)
  );
  // Redistribute plants: first batch gets cover+as much excess as fits event story
  // (100k cover-side + 15k excess-side), matching completion events.
  const plantParts =
    sorted.length >= 2
      ? [100000, 15000]
      : [TARGET_SOWED];

  for (let i = 0; i < sorted.length; i++) {
    const row = sorted[i];
    const plants = plantParts[i] != null ? plantParts[i] : 0;
    const coverTake = Math.min(coverLeft, plants);
    coverLeft -= coverTake;
    const excessTake =
      i === sorted.length - 1
        ? excessLeft
        : Math.min(excessLeft, Math.max(0, plants - coverTake));
    excessLeft -= excessTake;
    const stamp = excessFieldsForBatch(
      {
        plantsSowed: plants,
        orderCoveredPlants: coverTake,
        sowingBufferPct: BUFFER_PCT,
        excessAllocations: [],
        mortalityMovedToExcess: 0,
      },
      BUFFER_PCT
    );
    pushBatchChangeLog(row.batch, {
      kind: "COVER_POOL",
      plants,
      coverBefore: row.batch.orderCoveredPlants,
      coverAfter: coverTake,
      excessBefore: row.batch.shownExcess,
      excessAfter: stamp.shownExcess,
      reason: `SR003 fix: cover pool ${coverPool}, sow ${NEW_SOW_YMD}`,
    });
    await mongoose.connection.db.collection("plantslots").updateOne(
      {
        _id: row.docId,
        "subtypeSlots.slots._id": row.slotId,
        "subtypeSlots.slots.sowingBatches._id": row.batch._id,
      },
      {
        $set: {
          "subtypeSlots.$[st].slots.$[sl].sowingBatches.$[b].plantsSowed": plants,
          "subtypeSlots.$[st].slots.$[sl].sowingBatches.$[b].orderCoveredPlants": coverTake,
          "subtypeSlots.$[st].slots.$[sl].sowingBatches.$[b].excessPlants": stamp.shownExcess,
          "subtypeSlots.$[st].slots.$[sl].sowingBatches.$[b].shownExcess": stamp.shownExcess,
          "subtypeSlots.$[st].slots.$[sl].sowingBatches.$[b].sowingBufferPct": BUFFER_PCT,
          "subtypeSlots.$[st].slots.$[sl].sowingBatches.$[b].bufferPlants": stamp.bufferPlants,
          "subtypeSlots.$[st].slots.$[sl].sowingBatches.$[b].excessAllocations": [],
          "subtypeSlots.$[st].slots.$[sl].sowingBatches.$[b].changeLog": row.batch.changeLog,
        },
      },
      {
        arrayFilters: [
          { "st.subtypeId": row.subtypeId },
          { "sl._id": row.slotId },
          { "b._id": row.batch._id },
        ],
      }
    );
    console.log(
      `  patched batch ${row.batch._id}: sowed ${plants} cover ${coverTake} excess ${stamp.shownExcess}`
    );
  }

  // Move to Oct-ready slot + single consolidated batch via helper.
  const result = await editSowEntryOnSlots(req, {
    by: admin._id,
    sowDate: NEW_SOW_YMD,
    plantsSowed: TARGET_SOWED,
    reason: "EDIT_SOW_DATE",
  });

  // Re-stamp the new batch cover/excess (helper may have summed old split).
  const afterRows = await findBatches(rid);
  for (const row of afterRows) {
    const stamp = excessFieldsForBatch(
      {
        plantsSowed: TARGET_SOWED,
        orderCoveredPlants: coverPool,
        sowingBufferPct: BUFFER_PCT,
        excessAllocations: [],
      },
      BUFFER_PCT
    );
    pushBatchChangeLog(row.batch, {
      kind: "COVER_POOL",
      plants: TARGET_SOWED,
      coverBefore: row.batch.orderCoveredPlants,
      coverAfter: coverPool,
      excessBefore: row.batch.shownExcess,
      excessAfter: stamp.shownExcess,
      reason: `SR003 restamp after slot move · ready ${result.toReadyDate}`,
    });
    await mongoose.connection.db.collection("plantslots").updateOne(
      {
        _id: row.docId,
        "subtypeSlots.slots._id": row.slotId,
        "subtypeSlots.slots.sowingBatches._id": row.batch._id,
      },
      {
        $set: {
          "subtypeSlots.$[st].slots.$[sl].sowingBatches.$[b].plantsSowed": TARGET_SOWED,
          "subtypeSlots.$[st].slots.$[sl].sowingBatches.$[b].orderCoveredPlants": coverPool,
          "subtypeSlots.$[st].slots.$[sl].sowingBatches.$[b].excessPlants": stamp.shownExcess,
          "subtypeSlots.$[st].slots.$[sl].sowingBatches.$[b].shownExcess": stamp.shownExcess,
          "subtypeSlots.$[st].slots.$[sl].sowingBatches.$[b].sowingBufferPct": BUFFER_PCT,
          "subtypeSlots.$[st].slots.$[sl].sowingBatches.$[b].bufferPlants": stamp.bufferPlants,
          "subtypeSlots.$[st].slots.$[sl].sowingBatches.$[b].excessAllocations": [],
          "subtypeSlots.$[st].slots.$[sl].sowingBatches.$[b].linkedOrderIds": plan.full
            .map((f) => f.orderId)
            .concat(plan.partial?.orderId ? [plan.partial.orderId] : []),
          "subtypeSlots.$[st].slots.$[sl].sowingBatches.$[b].changeLog": row.batch.changeLog,
          "subtypeSlots.$[st].slots.$[sl].orderReservedPlants": coverPool,
          "subtypeSlots.$[st].slots.$[sl].plantsSowed": TARGET_SOWED,
          "subtypeSlots.$[st].slots.$[sl].primarySowed": TARGET_SOWED,
        },
      },
      {
        arrayFilters: [
          { "st.subtypeId": row.subtypeId },
          { "sl._id": row.slotId },
          { "b._id": row.batch._id },
        ],
      }
    );
  }

  // Re-FIFO order sown flags from cover pool.
  applyIncompleteRequestRelease(req, plan, { sowedAt: newSow });
  const fullIds = plan.full.map((f) => f.orderId);
  await Order.updateMany(
    { _id: { $in: fullIds } },
    {
      $set: {
        sowingDone: true,
        leftoverFromIncomplete: false,
        sowingDoneRequestId: rid,
        sowingDoneAt: newSow,
      },
      $unset: { sowingPartialCover: 1 },
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
            at: newSow,
          },
        },
      }
    );
  }

  req.status = "issued";
  req.sowingCompleted = true;
  req.sowingInProgress = false;
  req.sowingIncomplete = Boolean(plan.waiting?.length || plan.partial?.remaining);
  req.sowedQuantity = TARGET_SOWED;
  req.sowingCompletedDate = newSow;
  req.shedName = req.shedName || rows[0]?.batch?.shedName || "";
  req.linkedSlotIds = [result.toSlotId];
  req.markModified("linkedOrderIds");
  req.markModified("uncoveredOrderIds");

  for (const ev of req.completionEvents || []) {
    if (!["PLANTS_SOWED", "SOW_COMPLETED"].includes(ev.type) || !ev.meta) continue;
    ev.meta.sowDate = NEW_SOW_YMD;
    ev.meta.plantReadyDate = result.toReadyDate;
    ev.meta.orderReadyDate = result.toReadyDate;
    ev.meta.appliedSlotId = String(result.toSlotId);
    if (Number(ev.quantity) === 100000) {
      ev.meta.orderCoveredPlants = coverPool;
      ev.meta.excessPlants = 0;
    }
    if (Number(ev.quantity) === 15000) {
      ev.meta.orderCoveredPlants = 0;
      ev.meta.excessPlants = excessAfter;
    }
  }
  req.markModified("completionEvents");

  pushEvent(req, {
    type: "NOTE",
    by: admin._id,
    quantity: TARGET_SOWED,
    unit: "plants",
    message: `Cover gap fixed · sow ${fmtDDMMYYYY(new Date("2026-10-16T12:00:00Z"))} → ${result.sowingDate} · ready → ${result.toReadyDate} · cover pool ${coverPool} · excess ${excessAfter}`,
    meta: {
      editType: "SR003_COVER_AND_SOW_DATE",
      coverPool,
      excessAfter,
      fromReadyDate: result.fromReadyDate,
      toReadyDate: result.toReadyDate,
      slotChanged: result.slotChanged,
    },
  });
  await req.save();

  console.log(
    `APPLIED · slot ${result.fromReadyDate} → ${result.toReadyDate} · slotChanged=${result.slotChanged} · cover ${coverPool} · excess ${excessAfter}`
  );
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err?.message || err);
  process.exit(1);
});

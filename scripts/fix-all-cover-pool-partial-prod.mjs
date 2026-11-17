/**
 * For every sowing entry:
 *   saleable = sowed − CMS% (12/15…)
 *   FIFO cover from saleable
 *   leftover order → partial hold (sowingDone=false) so next sow can finish it
 *   waiting orders → unsown
 *
 * Orders already fully sown by a *different* request are skipped (next-day cover).
 * Never changes plantsSowed.
 *
 *   node scripts/fix-all-cover-pool-partial-prod.mjs
 *   node scripts/fix-all-cover-pool-partial-prod.mjs --apply
 */
import dotenv from "dotenv";
import mongoose from "mongoose";
import path from "path";
import { fileURLToPath } from "url";
import PlantCms from "../models/plantCms.model.js";
import Order from "../models/order.model.js";
import SowingRequest from "../models/sowingRequest.model.js";
import { sowCoverPool } from "../utility/lagwadSlotPlantsSplit.js";
import { excessFieldsForBatch } from "../utility/sowingBatchExcessStamp.js";
import {
  planOrderSowCover,
  applyIncompleteRequestRelease,
  requestCoverOrderIds,
} from "../services/orderSowCover.plan.js";
import { pushBatchChangeLog } from "../utility/sowingBatchChangeLog.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "..", ".env") });

const APPLY = process.argv.includes("--apply");
const CANCELLED = new Set(["CANCELLED", "REJECTED", "TEMPORARY_CANCELLED"]);

function oid(id) {
  if (!id) return null;
  if (id instanceof mongoose.Types.ObjectId) return id;
  const s = String(id?._id || id);
  return mongoose.Types.ObjectId.isValid(s) ? new mongoose.Types.ObjectId(s) : null;
}

/** Still belongs on this sow's FIFO (not finished by another request). */
function belongsToThisSow(order, requestId) {
  const rid = String(requestId || "");
  if (!order?.sowingDone) return true;
  const doneReq = String(order.sowingDoneRequestId || "");
  if (!doneReq) return true;
  if (rid && doneReq === rid) return true;
  // Done by another sow/request — next-day already covered; skip here.
  return false;
}

async function main() {
  const uri = process.env.PROD_MONGO_URL || process.env.MONGO_URL;
  if (!uri) throw new Error("Missing MONGO_URL / PROD_MONGO_URL");
  console.log(
    APPLY ? "APPLY cover-pool + partial (next-sow) — PROD\n" : "DRY-RUN cover-pool + partial — PROD\n"
  );

  await mongoose.connect(uri);
  const db = mongoose.connection.db;
  const plants = await PlantCms.find().select("sowingBuffer").lean();
  const pctByPlant = new Map(
    plants.map((p) => [String(p._id), Math.max(0, Number(p.sowingBuffer) || 0)])
  );

  const batchRows = await db
    .collection("plantslots")
    .aggregate([
      { $match: { "subtypeSlots.slots.sowingBatches.0": { $exists: true } } },
      { $unwind: { path: "$subtypeSlots", includeArrayIndex: "sti" } },
      { $unwind: { path: "$subtypeSlots.slots", includeArrayIndex: "sli" } },
      { $unwind: { path: "$subtypeSlots.slots.sowingBatches", includeArrayIndex: "bi" } },
      {
        $project: {
          plantId: 1,
          sti: 1,
          sli: 1,
          bi: 1,
          slotId: "$subtypeSlots.slots._id",
          reserved: "$subtypeSlots.slots.orderReservedPlants",
          batch: "$subtypeSlots.slots.sowingBatches",
        },
      },
    ])
    .toArray();

  let scanned = 0;
  let changed = 0;
  let partialsSet = 0;
  let waitingCleared = 0;
  let fullMarked = 0;
  let skippedDoneElsewhere = 0;
  const samples = [];

  for (const row of batchRows) {
    const batch = row.batch;
    if (!batch || batch.isIrrelevant) continue;
    scanned += 1;

    const sowed = Math.max(0, Math.floor(Number(batch.plantsSowed) || 0));
    if (sowed < 1) continue;

    const pct =
      batch.sowingBufferPct != null && Number.isFinite(Number(batch.sowingBufferPct))
        ? Number(batch.sowingBufferPct)
        : pctByPlant.get(String(row.plantId)) || 0;
    const coverPool = sowCoverPool(sowed, pct);
    const buffer = Math.round((sowed * pct) / 100);

    let req = null;
    const ridOid = oid(batch.sowingRequestId);
    if (ridOid) req = await SowingRequest.findById(ridOid);
    if (!req && batch.requestNumber) {
      req = await SowingRequest.findOne({ requestNumber: batch.requestNumber });
    }
    const requestId = req?._id || ridOid;

    // FIFO cover targets only — excessAllocations are a separate booking path
    // and must not pull orders into this sow's replan (re-marks partials as done).
    const idSet = new Set();
    for (const id of requestCoverOrderIds(req || {})) idSet.add(String(id));
    for (const id of batch.linkedOrderIds || []) idSet.add(String(id));
    const orderOids = [...idSet].map(oid).filter(Boolean);

    if (!orderOids.length) {
      const stamped = excessFieldsForBatch({ ...batch, orderCoveredPlants: Math.min(Number(batch.orderCoveredPlants)||0, coverPool) }, pct);
      // pure excess / no orders — keep cover 0 if none
      const nextCover = 0;
      const nextStamp = excessFieldsForBatch({ ...batch, orderCoveredPlants: nextCover }, pct);
      if (
        Number(batch.orderCoveredPlants) !== nextCover ||
        Number(batch.shownExcess) !== nextStamp.shownExcess
      ) {
        changed += 1;
        if (APPLY) {
          await db.collection("plantslots").updateOne(
            { _id: row._id },
            {
              $set: {
                [`subtypeSlots.${row.sti}.slots.${row.sli}.sowingBatches.${row.bi}.orderCoveredPlants`]: nextCover,
                [`subtypeSlots.${row.sti}.slots.${row.sli}.sowingBatches.${row.bi}.orderReservedPlantsApplied`]: nextCover,
                [`subtypeSlots.${row.sti}.slots.${row.sli}.sowingBatches.${row.bi}.sowingBufferPct`]: pct,
                [`subtypeSlots.${row.sti}.slots.${row.sli}.sowingBatches.${row.bi}.bufferPlants`]: nextStamp.bufferPlants,
                [`subtypeSlots.${row.sti}.slots.${row.sli}.sowingBatches.${row.bi}.shownExcess`]: nextStamp.shownExcess,
                [`subtypeSlots.${row.sti}.slots.${row.sli}.sowingBatches.${row.bi}.excessPlants`]: nextStamp.shownExcess,
                [`subtypeSlots.${row.sti}.slots.${row.sli}.excessiveSowing.plants`]: nextStamp.shownExcess,
              },
            }
          );
        }
      }
      continue;
    }

    const orders = await Order.find({ _id: { $in: orderOids } })
      .select(
        "_id orderId numberOfPlants additionalPlants deliveryDate createdAt orderStatus sowingDone sowingDoneRequestId sowingPartialCover leftoverFromIncomplete"
      )
      .sort({ deliveryDate: 1, createdAt: 1, orderId: 1 });

    const activeAll = orders.filter((o) => !CANCELLED.has(String(o.orderStatus || "")));
    const forThisSow = [];
    for (const o of activeAll) {
      if (!belongsToThisSow(o, requestId)) {
        skippedDoneElsewhere += 1;
        continue;
      }
      forThisSow.push(o);
    }

    // Plan with holds from OTHER requests kept; this request's holds cleared for planning.
    const cleanedForPlan = forThisSow.map((o) => {
      const plain = o.toObject();
      plain.sowingPartialCover = (plain.sowingPartialCover || []).filter(
        (h) => String(h.requestId) !== String(requestId || "")
      );
      // If previously marked done by THIS request, treat as not done for replan.
      if (requestId && String(plain.sowingDoneRequestId || "") === String(requestId)) {
        plain.sowingDone = false;
      }
      return plain;
    });

    const plan = planOrderSowCover({ plantsSowed: coverPool, orders: cleanedForPlan });
    const nextCover = plan.orderPlantsCovered;
    const stamped = excessFieldsForBatch(
      { ...batch, orderCoveredPlants: nextCover, sowingBufferPct: pct, bufferPlants: buffer },
      pct
    );
    const prevCover = Math.max(0, Math.floor(Number(batch.orderCoveredPlants) || 0));

    const needsChange =
      prevCover !== nextCover ||
      Number(batch.shownExcess) !== stamped.shownExcess ||
      Boolean(plan.partial) ||
      plan.waiting.length > 0 ||
      plan.full.length > 0;

    if (!needsChange && forThisSow.length === 0) continue;
    if (!needsChange) {
      // still ensure partial/waiting flags match
      let mismatch = false;
      if (plan.partial) {
        const po = forThisSow.find((o) => String(o._id) === String(plan.partial.orderId));
        const held = (po?.sowingPartialCover || [])
          .filter((h) => String(h.requestId) === String(requestId || ""))
          .reduce((s, h) => s + (Number(h.plants) || 0), 0);
        if (!po || po.sowingDone || held !== plan.partial.addPlants) mismatch = true;
      }
      for (const w of plan.waiting || []) {
        const wo = forThisSow.find((o) => String(o._id) === String(w.orderId));
        if (wo?.sowingDone) mismatch = true;
      }
      if (!mismatch) continue;
    }

    changed += 1;
    fullMarked += plan.full.length;
    if (plan.partial) partialsSet += 1;
    waitingCleared += plan.waiting.length;

    if (samples.length < 25) {
      samples.push({
        req: batch.requestNumber || String(requestId || ""),
        sowed,
        pct,
        coverPool,
        prevCover,
        nextCover,
        excess: stamped.shownExcess,
        full: plan.full.length,
        partial: plan.partial
          ? { orderId: plan.partial.orderId, plants: plan.partial.addPlants }
          : null,
        waiting: plan.waiting.length,
        skippedElsewhere: activeAll.length - forThisSow.length,
      });
    }

    if (!APPLY) continue;

    if (requestId) {
      await Order.updateMany(
        { _id: { $in: orderOids } },
        { $pull: { sowingPartialCover: { requestId } } }
      );
    }

    const fullIds = plan.full.map((f) => oid(f.orderId)).filter(Boolean);
    if (fullIds.length) {
      await Order.updateMany(
        { _id: { $in: fullIds } },
        {
          $set: {
            sowingDone: true,
            leftoverFromIncomplete: false,
            ...(requestId ? { sowingDoneRequestId: requestId } : {}),
          },
        }
      );
    }

    // Partial + waiting: MUST be unsown so next sow can cover.
    const leftoverIds = [
      plan.partial?.orderId,
      ...(plan.waiting || []).map((w) => w.orderId),
    ]
      .map(oid)
      .filter(Boolean);

    for (const oidLeft of leftoverIds) {
      await Order.updateOne(
        { _id: oidLeft },
        {
          $set: { sowingDone: false, leftoverFromIncomplete: true },
          $unset: { sowingDoneRequestId: "", sowingDoneAt: "" },
        }
      );
    }

    if (plan.partial?.orderId && plan.partial.addPlants > 0 && requestId) {
      await Order.updateOne(
        { _id: oid(plan.partial.orderId) },
        {
          $push: {
            sowingPartialCover: {
              requestId,
              plants: plan.partial.addPlants,
              at: new Date(),
            },
          },
        }
      );
    }

    if (req) {
      applyIncompleteRequestRelease(req, plan, {
        sowedAt: req.sowingCompletedDate || new Date(),
      });
      req.markModified("linkedOrderIds");
      req.markModified("uncoveredOrderIds");
      await req.save();
    }

    const prevReserved = Math.max(0, Math.floor(Number(row.reserved) || 0));
    const prevBatchReserved = Math.max(
      0,
      Math.floor(Number(batch.orderReservedPlantsApplied) || 0)
    );
    const reservedDelta = prevBatchReserved - nextCover;
    const nextSlotReserved = Math.max(0, prevReserved - reservedDelta);

    pushBatchChangeLog(batch, {
      kind: "COVER_POOL",
      plants: coverPool,
      coverBefore: prevCover,
      coverAfter: nextCover,
      excessBefore: batch.shownExcess,
      excessAfter: stamped.shownExcess,
      reason: `Re-FIFO saleable ${coverPool} (sowed ${sowed} − ${pct}%); partial→next sow`,
    });

    await db.collection("plantslots").updateOne(
      { _id: row._id },
      {
        $set: {
          [`subtypeSlots.${row.sti}.slots.${row.sli}.sowingBatches.${row.bi}.orderCoveredPlants`]:
            nextCover,
          [`subtypeSlots.${row.sti}.slots.${row.sli}.sowingBatches.${row.bi}.orderReservedPlantsApplied`]:
            nextCover,
          [`subtypeSlots.${row.sti}.slots.${row.sli}.sowingBatches.${row.bi}.sowingBufferPct`]: pct,
          [`subtypeSlots.${row.sti}.slots.${row.sli}.sowingBatches.${row.bi}.bufferPlants`]:
            stamped.bufferPlants,
          [`subtypeSlots.${row.sti}.slots.${row.sli}.sowingBatches.${row.bi}.shownExcess`]:
            stamped.shownExcess,
          [`subtypeSlots.${row.sti}.slots.${row.sli}.sowingBatches.${row.bi}.excessPlants`]:
            stamped.shownExcess,
          [`subtypeSlots.${row.sti}.slots.${row.sli}.sowingBatches.${row.bi}.changeLog`]:
            batch.changeLog,
          [`subtypeSlots.${row.sti}.slots.${row.sli}.orderReservedPlants`]: nextSlotReserved,
          [`subtypeSlots.${row.sti}.slots.${row.sli}.excessiveSowing.plants`]: stamped.shownExcess,
        },
      }
    );
  }

  console.log(
    JSON.stringify(
      {
        apply: APPLY,
        scanned,
        batchesChanged: changed,
        fullMarked,
        partialsSet,
        waitingCleared,
        skippedDoneElsewhere,
        samples,
      },
      null,
      2
    )
  );

  await mongoose.disconnect();
  if (!APPLY) console.log("\nRe-run with --apply to write PROD");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

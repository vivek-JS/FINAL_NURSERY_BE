/**
 * Prod fix: cover unsown orders using leftover sow capacity within readyDate ±4d.
 *
 * Finds completed sowing requests (and slot excess) where plants remain after
 * prior exact-day cover, then FIFO-marks eligible orders in the ±4 window.
 *
 * Usage:
 *   node scripts/backfill-order-cover-window-prod.mjs           # dry-run (default)
 *   node scripts/backfill-order-cover-window-prod.mjs --dry-run
 *   node scripts/backfill-order-cover-window-prod.mjs --apply   # writes prod
 *
 * Optional:
 *   --days=60     look back N days of completions (default 60)
 *   --limit=200   max requests to process (default 200)
 */
import "dotenv/config";
import mongoose from "mongoose";
import SowingRequest from "../models/sowingRequest.model.js";
import Order from "../models/order.model.js";
import PlantSlot from "../models/slots.model.js";
import PlantCms from "../models/plantCms.model.js";
import {
  ORDER_COVER_WINDOW_DAYS,
  deliveryCoverWindow,
  markOrdersSowed,
  reclaimExcessForCoveredOrders,
  recordExcessPlantsOnSlot,
  pushEvent,
} from "../controllers/sowingCompleteHelpers.js";
import {
  addDays,
  fmtDDMMYYYY,
  resolveCmsReadyDays,
} from "../controllers/sowingSlotReadyHelpers.js";

const APPLY = process.argv.includes("--apply");
const DRY = !APPLY;

function argNum(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (!hit) return fallback;
  const n = Number(hit.split("=")[1]);
  return Number.isFinite(n) ? n : fallback;
}

const LOOKBACK_DAYS = argNum("days", 60);
const LIMIT = argNum("limit", 200);

function prodUri() {
  const url = process.env.PROD_MONGO_URL;
  if (!url) throw new Error("PROD_MONGO_URL required");
  return url;
}

function orderNeed(o) {
  return (
    (Number(o.numberOfPlants) || 0) + (Number(o.additionalPlants) || 0)
  );
}

function dayLabel(d) {
  if (!d) return "—";
  try {
    return fmtDDMMYYYY(d instanceof Date ? d : new Date(d));
  } catch {
    return String(d);
  }
}

function subDays(date, days) {
  const d = new Date(date.getTime());
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - Math.max(0, Number(days) || 0));
  return d;
}

async function simulateCover({
  plantId,
  subtypeId,
  sowedAt,
  plantsCapacity,
  readyDays,
  windowDays,
  readyDateOverride = null,
}) {
  const remaining0 = Math.max(0, Math.floor(plantsCapacity));
  if (remaining0 <= 0) {
    return {
      wouldMark: [],
      plantsUsed: 0,
      remainingAfter: 0,
      eligibleCount: 0,
      readyDate: null,
      coverFrom: null,
      coverTo: null,
    };
  }

  let rd = Number(readyDays);
  if (!Number.isFinite(rd) || rd <= 0) {
    rd = await resolveCmsReadyDays(plantId, subtypeId);
  }
  rd = Math.max(0, Number(rd) || 0);
  const readyDate =
    readyDateOverride instanceof Date && !Number.isNaN(readyDateOverride.getTime())
      ? readyDateOverride
      : addDays(sowedAt, rd);
  const { dayStart, dayEnd } = deliveryCoverWindow(readyDate, windowDays);

  const query = {
    plantName: plantId,
    plantSubtype: subtypeId,
    sowingDone: { $ne: true },
    deliveryDate: { $gte: dayStart, $lte: dayEnd },
    orderStatus: {
      $nin: ["CANCELLED", "TEMPORARY_CANCELLED", "REJECTED", "DELETED"],
    },
  };

  const orders = await Order.find(query)
    .select(
      "_id orderId name numberOfPlants additionalPlants deliveryDate createdAt"
    )
    .sort({ deliveryDate: 1, createdAt: 1, orderId: 1 })
    .lean();

  let remaining = remaining0;
  const wouldMark = [];
  for (const o of orders) {
    const need = orderNeed(o);
    if (need <= 0) continue;
    if (remaining < need) break;
    const del = o.deliveryDate ? new Date(o.deliveryDate) : null;
    let offset = null;
    if (del && !Number.isNaN(del.getTime())) {
      const d0 = Date.UTC(del.getFullYear(), del.getMonth(), del.getDate());
      const r0 = Date.UTC(
        readyDate.getFullYear(),
        readyDate.getMonth(),
        readyDate.getDate()
      );
      offset = Math.round((d0 - r0) / 86400000);
    }
    wouldMark.push({
      orderId: o._id,
      orderNumber: o.orderId,
      farmer: o.name || "",
      plants: need,
      deliveryDate: o.deliveryDate,
      coverOffsetDays: offset,
    });
    remaining -= need;
  }

  return {
    wouldMark,
    plantsUsed: remaining0 - remaining,
    remainingAfter: remaining,
    eligibleCount: orders.length,
    readyDate,
    coverFrom: dayStart,
    coverTo: dayEnd,
    readyDays: rd,
  };
}

async function main() {
  console.log(
    `\n=== Order cover window backfill (±${ORDER_COVER_WINDOW_DAYS}d) ===`
  );
  console.log(DRY ? "MODE: DRY-RUN (no writes)" : "MODE: APPLY (writes prod)");
  console.log(`Lookback: ${LOOKBACK_DAYS}d · limit: ${LIMIT}\n`);

  await mongoose.connect(prodUri(), { maxPoolSize: 5 });
  console.log("Connected:", mongoose.connection.name);

  const since = new Date();
  since.setDate(since.getDate() - LOOKBACK_DAYS);
  since.setHours(0, 0, 0, 0);

  const requests = await SowingRequest.find({
    sowingCompleted: true,
    sowedQuantity: { $gt: 0 },
    sowingCompletedDate: { $gte: since },
  })
    .select(
      "requestNumber plantId plantName subtypeId subtypeName sowedQuantity sowingCompletedDate isExcessiveSowing linkedOrderIds linkedSlotIds completionEvents conversionFactor"
    )
    .sort({ sowingCompletedDate: 1 })
    .limit(LIMIT)
    .lean();

  console.log(`Completed requests in window: ${requests.length}`);

  const summary = [];
  let totalWouldMark = 0;
  let totalPlantsUsed = 0;
  let totalCapacityLeft = 0;
  /** Same order must not be claimed by two requests in this dry-run/apply pass */
  const claimedOrderIds = new Set();

  for (const req of requests) {
    const sowedAt =
      req.sowingCompletedDate instanceof Date &&
      !Number.isNaN(req.sowingCompletedDate.getTime())
        ? req.sowingCompletedDate
        : new Date();

    const coveredOrders = await Order.find({
      sowingDoneRequestId: req._id,
      sowingDone: true,
    })
      .select("numberOfPlants additionalPlants")
      .lean();
    const alreadyCovered = coveredOrders.reduce((s, o) => s + orderNeed(o), 0);
    const sowed = Math.max(0, Math.floor(Number(req.sowedQuantity) || 0));
    const capacity = Math.max(0, sowed - alreadyCovered);

    if (capacity <= 0) {
      continue;
    }

    const sowEv = (req.completionEvents || []).find(
      (e) => e?.type === "SOW_COMPLETED"
    );
    const readyDaysMeta = Number(
      sowEv?.meta?.orderPlantReadyDays ??
        sowEv?.meta?.plantReadyDays ??
        NaN
    );

    const sim = await simulateCover({
      plantId: req.plantId,
      subtypeId: req.subtypeId,
      sowedAt,
      plantsCapacity: capacity,
      readyDays: readyDaysMeta,
      windowDays: ORDER_COVER_WINDOW_DAYS,
    });

    // Drop orders already claimed by an earlier (older) request in this pass
    const uniqueMarks = [];
    let used = 0;
    let rem = capacity;
    for (const o of sim.wouldMark) {
      const id = String(o.orderId);
      if (claimedOrderIds.has(id)) continue;
      if (rem < o.plants) break;
      uniqueMarks.push(o);
      claimedOrderIds.add(id);
      rem -= o.plants;
      used += o.plants;
    }

    if (!uniqueMarks.length) {
      totalCapacityLeft += capacity;
      continue;
    }

    totalWouldMark += uniqueMarks.length;
    totalPlantsUsed += used;
    totalCapacityLeft += rem;

    const row = {
      requestNumber: req.requestNumber,
      requestId: String(req._id),
      plant: `${req.plantName || ""} · ${req.subtypeName || ""}`.trim(),
      sowDate: dayLabel(sowedAt),
      readyDate: dayLabel(sim.readyDate),
      coverFrom: dayLabel(sim.coverFrom),
      coverTo: dayLabel(sim.coverTo),
      readyDays: sim.readyDays,
      isExcess: Boolean(req.isExcessiveSowing),
      sowed,
      alreadyCovered,
      capacity,
      wouldMarkCount: uniqueMarks.length,
      plantsUsed: used,
      remainingAfter: rem,
      eligibleInWindow: sim.eligibleCount,
      markIds: uniqueMarks.map((o) => o.orderId),
      orders: uniqueMarks.map(
        (o) =>
          `#${o.orderNumber} ${o.farmer} ${o.plants}p del=${dayLabel(
            o.deliveryDate
          )} (${
            o.coverOffsetDays == null
              ? "?"
              : o.coverOffsetDays === 0
                ? "ready"
                : o.coverOffsetDays > 0
                  ? `+${o.coverOffsetDays}d`
                  : `${o.coverOffsetDays}d`
          })`
      ),
    };
    summary.push(row);

    console.log("─".repeat(72));
    console.log(
      `${row.requestNumber} | ${row.plant} | sow ${row.sowDate} → ready ${row.readyDate}`
    );
    console.log(
      `  window ${row.coverFrom} … ${row.coverTo} (±${ORDER_COVER_WINDOW_DAYS}d)` +
        (row.isExcess ? " · EXCESS req" : "")
    );
    console.log(
      `  sowed ${row.sowed} · already covered ${row.alreadyCovered} · free capacity ${row.capacity}`
    );
    console.log(
      `  → would mark ${row.wouldMarkCount} orders · use ${row.plantsUsed} plants · leftover ${row.remainingAfter}`
    );
    for (const line of row.orders) console.log(`     ${line}`);

    if (!DRY) {
      const full = await SowingRequest.findById(req._id);
      if (!full) continue;
      // markOrdersSowed re-queries live DB — already-claimed orders are sowingDone
      const orderResult = await markOrdersSowed(full, {
        sowedAt,
        plantsSowed: capacity,
        plantReadyDays: sim.readyDays,
        coverWindowDays: ORDER_COVER_WINDOW_DAYS,
      });
      const orderCoveredPlants = Math.max(
        0,
        capacity - (Number(orderResult.remainingUncovered) || 0)
      );
      const excessLeft = Math.max(
        0,
        Number(orderResult.remainingUncovered) || 0
      );

      const appliedSlotId =
        sowEv?.meta?.appliedSlotId ||
        (Array.isArray(req.linkedSlotIds) && req.linkedSlotIds[0]) ||
        null;

      if (appliedSlotId && orderCoveredPlants > 0) {
        if (full.isExcessiveSowing) {
          await reclaimExcessForCoveredOrders(
            appliedSlotId,
            full._id,
            orderCoveredPlants,
            excessLeft
          );
        } else {
          await recordExcessPlantsOnSlot(
            appliedSlotId,
            full._id,
            excessLeft,
            alreadyCovered + orderCoveredPlants
          );
        }
      }

      pushEvent(full, {
        type: "ORDERS_MARKED_SOWED",
        quantity: orderCoveredPlants,
        unit: "plants",
        message: `Backfill ±${ORDER_COVER_WINDOW_DAYS}d: marked ${orderResult.marked} orders`,
        meta: {
          dryRun: false,
          backfill: true,
          marked: orderResult.marked,
          plantsUsed: orderCoveredPlants,
          remainingUncovered: excessLeft,
          coverFrom: orderResult.coverFrom,
          coverTo: orderResult.coverTo,
          readyDate: orderResult.readyDate,
        },
      });
      await full.save();
      console.log(
        `  APPLIED: marked ${orderResult.marked} · leftover ${excessLeft}`
      );
    }
  }

  // Repair: orders already marked in a prior partial apply, but request save failed
  if (!DRY) {
    console.log("\n=== Repair linkedOrderIds / excess for already-marked ===");
    for (const req of requests) {
      const covered = await Order.find({
        sowingDoneRequestId: req._id,
        sowingDone: true,
      })
        .select("_id numberOfPlants additionalPlants")
        .lean();
      if (!covered.length) continue;
      const coveredPlants = covered.reduce((s, o) => s + orderNeed(o), 0);
      const linked = (req.linkedOrderIds || []).map(String);
      const needSync = covered.some((o) => !linked.includes(String(o._id)));
      if (!needSync) continue;

      const full = await SowingRequest.findById(req._id);
      if (!full) continue;
      full.linkedOrderIds = covered.map((o) => o._id);
      const sowed = Math.max(0, Math.floor(Number(full.sowedQuantity) || 0));
      const excessLeft = Math.max(0, sowed - coveredPlants);
      const sowEv = (full.completionEvents || []).find(
        (e) => e?.type === "SOW_COMPLETED"
      );
      const appliedSlotId =
        sowEv?.meta?.appliedSlotId ||
        (Array.isArray(full.linkedSlotIds) && full.linkedSlotIds[0]) ||
        null;
      if (appliedSlotId) {
        if (full.isExcessiveSowing) {
          await reclaimExcessForCoveredOrders(
            appliedSlotId,
            full._id,
            coveredPlants,
            excessLeft
          );
        } else {
          await recordExcessPlantsOnSlot(
            appliedSlotId,
            full._id,
            excessLeft,
            coveredPlants
          );
        }
      }
      pushEvent(full, {
        type: "ORDERS_MARKED_SOWED",
        quantity: coveredPlants,
        unit: "plants",
        message: `Backfill repair: synced ${covered.length} covered orders (±${ORDER_COVER_WINDOW_DAYS}d)`,
        meta: {
          backfill: true,
          repair: true,
          marked: covered.length,
          plantsUsed: coveredPlants,
          remainingUncovered: excessLeft,
        },
      });
      await full.save();
      console.log(
        `  REPAIR ${full.requestNumber}: linked ${covered.length} orders · covered ${coveredPlants} · excess ${excessLeft}`
      );
    }
  }

  // Slot-level excess not already counted via request capacity (orphan / stale)
  // Skip for dry-run noise if request pass already covered — optional second pass
  // using slot.excessiveSowing when request free capacity was 0 but excess remains.
  const slotExcessHits = [];
  const slotDocs = await PlantSlot.aggregate([
    { $unwind: "$subtypeSlots" },
    { $unwind: "$subtypeSlots.slots" },
    {
      $match: {
        "subtypeSlots.slots.excessiveSowing.plants": { $gt: 0 },
      },
    },
    {
      $project: {
        plantId: 1,
        subtypeId: "$subtypeSlots.subtypeId",
        slotId: "$subtypeSlots.slots._id",
        startDay: "$subtypeSlots.slots.startDay",
        plantReadyDate: "$subtypeSlots.slots.plantReadyDate",
        plantReadyDays: "$subtypeSlots.slots.plantReadyDays",
        excess: "$subtypeSlots.slots.excessiveSowing.plants",
        batches: { $slice: ["$subtypeSlots.slots.sowingBatches", 5] },
      },
    },
    { $sort: { excess: -1 } },
    { $limit: 80 },
  ]);

  for (const sl of slotDocs) {
    const excess = Math.max(0, Math.floor(Number(sl.excess) || 0));
    if (excess <= 0) continue;

    // Prefer ready date from slot; else parse startDay as ready day
    let readyDate = null;
    if (sl.plantReadyDate) {
      const m = String(sl.plantReadyDate).match(/^(\d{2})-(\d{2})-(\d{4})$/);
      if (m) {
        readyDate = new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]), 12);
      }
    }
    if (!readyDate && sl.startDay) {
      const m = String(sl.startDay).match(/^(\d{2})-(\d{2})-(\d{4})$/);
      if (m) {
        readyDate = new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]), 12);
      }
    }
    if (!readyDate) continue;

    // Capacity already used by a request in this run? Skip double-count if
    // batch sowingRequestId was in summary. Still report slot excess for visibility.
    const batchReqIds = new Set(
      (sl.batches || [])
        .map((b) => String(b.sowingRequestId || ""))
        .filter(Boolean)
    );
    const alreadyInSummary = summary.some((r) =>
      batchReqIds.has(r.requestId)
    );

    const rd =
      Number(sl.plantReadyDays) > 0
        ? Number(sl.plantReadyDays)
        : await resolveCmsReadyDays(sl.plantId, sl.subtypeId);
    const sowedAt = subDays(readyDate, rd);

    const sim = await simulateCover({
      plantId: sl.plantId,
      subtypeId: sl.subtypeId,
      sowedAt,
      plantsCapacity: excess,
      readyDays: rd,
      windowDays: ORDER_COVER_WINDOW_DAYS,
      readyDateOverride: readyDate,
    });

    if (!sim.wouldMark.length) continue;

    const plant = await PlantCms.findById(sl.plantId)
      .select("name subtypes._id subtypes.name")
      .lean();
    const st = (plant?.subtypes || []).find(
      (s) => String(s._id) === String(sl.subtypeId)
    );

    slotExcessHits.push({
      slotId: String(sl.slotId),
      plant: `${plant?.name || ""} · ${st?.name || ""}`.trim(),
      readyDate: dayLabel(readyDate),
      excess,
      wouldMarkCount: sim.wouldMark.length,
      plantsUsed: sim.plantsUsed,
      alreadyInRequestPass: alreadyInSummary,
      orders: sim.wouldMark.slice(0, 8).map(
        (o) =>
          `#${o.orderNumber} ${o.plants}p ${dayLabel(o.deliveryDate)} (${
            o.coverOffsetDays === 0
              ? "ready"
              : o.coverOffsetDays > 0
                ? `+${o.coverOffsetDays}d`
                : `${o.coverOffsetDays}d`
          })`
      ),
    });
  }

  if (slotExcessHits.length) {
    console.log("\n=== Slot excess that could still cover (±4d) ===");
    for (const h of slotExcessHits) {
      if (h.alreadyInRequestPass) continue; // request pass will handle
      console.log("─".repeat(72));
      console.log(
        `SLOT ${h.slotId} | ${h.plant} | ready ${h.readyDate} | excess ${h.excess}`
      );
      console.log(
        `  → could mark ${h.wouldMarkCount} · use ${h.plantsUsed} (info only in this script; apply via request pass)`
      );
      for (const line of h.orders) console.log(`     ${line}`);
    }
  }

  console.log("\n=== SUMMARY ===");
  console.log(`Requests with actionable cover: ${summary.length}`);
  console.log(`Orders that would be marked:    ${totalWouldMark}`);
  console.log(`Plants that would be used:      ${totalPlantsUsed}`);
  console.log(`Capacity leftover after cover:  ${totalCapacityLeft}`);
  if (DRY) {
    console.log(
      "\nDry-run only. Re-run with --apply to write sowingDone on listed orders."
    );
  }

  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error(err);
  try {
    await mongoose.disconnect();
  } catch {
    /* ignore */
  }
  process.exit(1);
});

/**
 * Backfill OrderEvent collection from embedded order history arrays.
 *
 * Usage:
 *   node scripts/backfill-order-events.js --dry-run
 *   node scripts/backfill-order-events.js --domain=PLANT
 *   node scripts/backfill-order-events.js --domain=AGRI
 *   node scripts/backfill-order-events.js --since=2024-01-01
 *   node scripts/backfill-order-events.js --batchSize=500
 */
import dotenv from "dotenv";
import mongoose from "mongoose";
import Order from "../models/order.model.js";
import AgriSalesOrder from "../models/agriSalesOrder.model.js";
import OrderEvent from "../modules/orderEvents/models/orderEvent.model.js";
import {
  ORDER_DOMAINS,
  ORDER_EVENT_SOURCE,
  ORDER_EVENT_TYPES,
  emitOrderEvent,
  buildIdempotencyKey,
} from "../modules/orderEvents/index.js";
import {
  buildEventPayloadFromEditEntry,
  buildDeliveryChangePayloads,
  buildStatusChangePayload,
} from "../modules/orderEvents/events/mapEditHistoryToEvents.js";

function readArg(name) {
  const prefix = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : null;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

async function backfillPlantOrder(lean, { dryRun }) {
  const orderId = lean._id;
  let created = 0;
  let skipped = 0;

  const emit = async (payload, idempotencyKey) => {
    if (dryRun) {
      created += 1;
      return;
    }
    const existing = await OrderEvent.findOne({ idempotencyKey }).select("_id").lean();
    if (existing) {
      skipped += 1;
      return;
    }
    const doc = await emitOrderEvent({
      ...payload,
      orderDomain: ORDER_DOMAINS.PLANT,
      orderId,
      idempotencyKey,
      source: ORDER_EVENT_SOURCE.MIGRATION,
    });
    if (doc) created += 1;
    else skipped += 1;
  };

  for (const entry of lean.orderEditHistory || []) {
    const p = buildEventPayloadFromEditEntry(entry);
    await emit(
      {
        ...p,
        occurredAt: entry.createdAt || lean.updatedAt,
        refs: { legacySource: "orderEditHistory" },
      },
      buildIdempotencyKey("migration", "plant", "edit", orderId, entry._id || entry.field, entry.createdAt)
    );
  }

  for (const sc of lean.statusChanges || []) {
    const p = buildStatusChangePayload(sc);
    await emit(
      {
        ...p,
        actorId: sc.changedBy,
        reason: sc.reason,
        occurredAt: sc.createdAt || lean.updatedAt,
        refs: { legacySource: "statusChanges" },
      },
      buildIdempotencyKey("migration", "plant", "status", orderId, sc._id || sc.createdAt)
    );
  }

  for (const dc of lean.deliveryChanges || []) {
    const payloads = buildDeliveryChangePayloads(dc, { changedBy: dc.changedBy });
    for (let i = 0; i < payloads.length; i++) {
      const p = payloads[i];
      await emit(
        {
          ...p,
          reason: dc.reasonForChange,
          occurredAt: dc.createdAt || lean.updatedAt,
          refs: { legacySource: "deliveryChanges" },
        },
        buildIdempotencyKey("migration", "plant", "delivery", orderId, dc._id, i)
      );
    }
  }

  for (const fr of lean.farmReadyDateChanges || []) {
    await emit(
      {
        eventType: ORDER_EVENT_TYPES.PLANT_READY_UPDATED,
        field: "farmReadyDate",
        previousValue: fr.previousDate,
        newValue: fr.newDate,
        description: fr.notes || "Farm ready date changed",
        actorId: fr.changedBy,
        reason: fr.reason,
        occurredAt: fr.createdAt || lean.updatedAt,
        refs: { legacySource: "farmReadyDateChanges" },
      },
      buildIdempotencyKey("migration", "plant", "farm-ready", orderId, fr._id || fr.createdAt)
    );
  }

  for (const dh of lean.dispatchHistory || []) {
    await emit(
      {
        eventType: ORDER_EVENT_TYPES.DISPATCH_COMPLETED,
        description: `Dispatched ${dh.quantity} plants`,
        newValue: dh,
        actorId: dh.processedBy,
        occurredAt: dh.date || lean.updatedAt,
        refs: {
          legacySource: "dispatchHistory",
          dispatchId: dh.dispatchId,
          plantOutwardId: dh.plantOutwardId,
        },
      },
      buildIdempotencyKey("migration", "plant", "dispatch", orderId, dh.dispatchId || dh.date)
    );
  }

  for (const sh of lean.splitHistory || []) {
    await emit(
      {
        eventType: ORDER_EVENT_TYPES.ORDER_SPLIT,
        description: `Split action: ${sh.action}`,
        previousValue: sh.originalQuantity,
        newValue: sh.quantityAfterSplit,
        actorId: sh.performedBy,
        metadata: sh,
        occurredAt: sh.createdAt || lean.updatedAt,
        refs: { legacySource: "splitHistory", relatedOrderId: sh.relatedOrderId },
      },
      buildIdempotencyKey("migration", "plant", "split", orderId, sh._id || sh.action, sh.relatedOrderId)
    );
  }

  for (const ap of lean.additionalPlantsHistory || []) {
    await emit(
      {
        eventType: ORDER_EVENT_TYPES.ORDER_QUANTITY_CHANGED,
        field: "additionalPlants",
        previousValue: ap.previousTotal,
        newValue: ap.newTotal,
        description: ap.notes || "Additional plants changed",
        actorId: ap.changedBy,
        reason: ap.reason,
        occurredAt: ap.createdAt || lean.updatedAt,
        refs: { legacySource: "additionalPlantsHistory" },
      },
      buildIdempotencyKey("migration", "plant", "additional", orderId, ap._id || ap.createdAt)
    );
  }

  return { created, skipped };
}

async function backfillAgriOrder(lean, { dryRun }) {
  const orderId = lean._id;
  let created = 0;
  let skipped = 0;

  const logs = lean.activityLog || [];
  for (let i = 0; i < logs.length; i++) {
    const entry = logs[i];
    const idempotencyKey = buildIdempotencyKey("migration", "agri", "log", orderId, i, entry.action);
    if (dryRun) {
      created += 1;
      continue;
    }
    const existing = await OrderEvent.findOne({ idempotencyKey }).select("_id").lean();
    if (existing) {
      skipped += 1;
      continue;
    }
    const doc = await emitOrderEvent({
      orderDomain: ORDER_DOMAINS.AGRI,
      orderId,
      eventType: entry.action || ORDER_EVENT_TYPES.ORDER_UPDATED,
      idempotencyKey,
      description: entry.description,
      previousValue: entry.previousValue,
      newValue: entry.newValue,
      actorId: entry.performedBy,
      actorName: entry.performedByName,
      metadata: entry.metadata,
      occurredAt: entry.createdAt || lean.updatedAt,
      source: ORDER_EVENT_SOURCE.MIGRATION,
      refs: { legacySource: "activityLog" },
    });
    if (doc) created += 1;
    else skipped += 1;
  }

  return { created, skipped };
}

async function main() {
  dotenv.config();
  const uri =
    process.env.PROD_MONGO_URL ||
    process.env.MONGO_URL ||
    process.env.MONGODB_URI ||
    process.env.DATABASE;
  if (!uri) {
    console.error("Set PROD_MONGO_URL/MONGO_URL/MONGODB_URI/DATABASE");
    process.exit(1);
  }

  const dryRun = hasFlag("dry-run");
  const domain = readArg("domain") || "ALL";
  const since = readArg("since");
  const batchSize = parseInt(readArg("batchSize") || "500", 10);

  await mongoose.connect(uri);
  console.log(`Connected. Backfill OrderEvents (dryRun=${dryRun}, domain=${domain})`);

  const dateFilter = {};
  if (since) {
    const start = new Date(`${since}T00:00:00.000Z`);
    if (!Number.isNaN(start.getTime())) {
      dateFilter.createdAt = { $gte: start };
    }
  }

  let totalCreated = 0;
  let totalSkipped = 0;

  if (domain === "ALL" || domain === "PLANT") {
    const cursor = Order.find(dateFilter).select(
      "orderEditHistory statusChanges deliveryChanges farmReadyDateChanges dispatchHistory splitHistory additionalPlantsHistory updatedAt"
    ).cursor({ batchSize });

    let batch = 0;
    for await (const lean of cursor) {
      const { created, skipped } = await backfillPlantOrder(lean, { dryRun });
      totalCreated += created;
      totalSkipped += skipped;
      batch += 1;
      if (batch % batchSize === 0) {
        console.log(`PLANT processed ${batch} orders… created≈${totalCreated} skipped≈${totalSkipped}`);
      }
    }
    console.log(`PLANT done. created≈${totalCreated} skipped≈${totalSkipped}`);
  }

  if (domain === "ALL" || domain === "AGRI") {
    let agriCreated = 0;
    let agriSkipped = 0;
    const cursor = AgriSalesOrder.find(dateFilter)
      .select("activityLog updatedAt")
      .cursor({ batchSize });

    let batch = 0;
    for await (const lean of cursor) {
      const { created, skipped } = await backfillAgriOrder(lean, { dryRun });
      agriCreated += created;
      agriSkipped += skipped;
      batch += 1;
      if (batch % batchSize === 0) {
        console.log(`AGRI processed ${batch} orders…`);
      }
    }
    totalCreated += agriCreated;
    totalSkipped += agriSkipped;
    console.log(`AGRI done. created≈${agriCreated} skipped≈${agriSkipped}`);
  }

  console.log(`Finished. Total created≈${totalCreated} skipped≈${totalSkipped}`);
  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

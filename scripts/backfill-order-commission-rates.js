/**
 * Backfill commissionRatePerPlant on orders where salesPerson is a DEALER.
 *
 * Uses the current DealerCommissionRate table (or DEFAULT_COMMISSION_RATE).
 * True historical rates cannot be recovered if they were never snapshotted at placement.
 *
 * For each updated order:
 * - Sets commissionRatePerPlant
 * - Appends orderEditHistory on the order
 * - Emits an OrderEvent (activity log) with MIGRATION source
 *
 * Usage:
 *   node scripts/backfill-order-commission-rates.js [--dry-run] [--batch=500]
 *   node scripts/backfill-order-commission-rates.js --sync-activity   # orders already have rate, add history+event only
 *   node scripts/backfill-order-commission-rates.js --prod --dry-run
 *   node scripts/backfill-order-commission-rates.js --prod
 */
import mongoose from "mongoose";
import dotenv from "dotenv";
import Order from "../models/order.model.js";
import User from "../models/user.model.js";
import OrderEvent from "../modules/orderEvents/models/orderEvent.model.js";
import {
  DEFAULT_COMMISSION_RATE,
  loadCommissionRatesMap,
} from "../services/dealerCommission.service.js";
import {
  ORDER_DOMAINS,
  ORDER_EVENT_SOURCE,
  ORDER_EVENT_TYPES,
  buildIdempotencyKey,
  emitOrderEvent,
} from "../modules/orderEvents/index.js";

dotenv.config();

const dryRun = process.argv.includes("--dry-run");
const useProd = process.argv.includes("--prod");
const syncActivityOnly = process.argv.includes("--sync-activity");
const batchArg = process.argv.find((a) => a.startsWith("--batch="));
const batchSize = batchArg ? parseInt(batchArg.split("=")[1], 10) : 500;

function migrationEventKey(orderMongoId) {
  return buildIdempotencyKey(
    "migration",
    "plant",
    "commission-backfill",
    orderMongoId
  );
}

const BACKFILL_NOTES =
  "Commission rate per plant backfilled from DealerCommissionRate (rates at backfill time). Future commission config changes will not affect this order.";

function buildEditHistoryEntry(previousValue, newValue) {
  return {
    field: "commissionRatePerPlant",
    previousValue,
    newValue,
    changedBy: null,
    notes: BACKFILL_NOTES,
  };
}

async function backfillOneOrder(order, rate, { correlationId, rateOnly = false }) {
  const previousValue = order.commissionRatePerPlant ?? null;
  const resolvedRate = rateOnly ? Number(order.commissionRatePerPlant) : rate;
  const editEntry = buildEditHistoryEntry(previousValue, resolvedRate);

  if (dryRun) {
    return { updated: true, eventEmitted: true };
  }

  const update = { $push: { orderEditHistory: editEntry } };
  if (!rateOnly) {
    update.$set = { commissionRatePerPlant: rate };
  }

  await Order.updateOne({ _id: order._id }, update);

  await emitOrderEvent({
    orderDomain: ORDER_DOMAINS.PLANT,
    orderId: order._id,
    eventType: ORDER_EVENT_TYPES.ORDER_FIELD_CHANGED,
    field: "commissionRatePerPlant",
    previousValue,
    newValue: resolvedRate,
    description: BACKFILL_NOTES,
    actorName: "System (commission backfill)",
    correlationId,
    source: ORDER_EVENT_SOURCE.MIGRATION,
    idempotencyKey: buildIdempotencyKey(
      "migration",
      "plant",
      "commission-backfill",
      order._id
    ),
    metadata: {
      script: "backfill-order-commission-rates.js",
      displayOrderId: order.orderId,
      plantId: order.plantName?.toString?.() ?? String(order.plantName || ""),
      subtypeId:
        order.plantSubtype?.toString?.() ?? String(order.plantSubtype || ""),
    },
  });

  return { updated: true, eventEmitted: true };
}

async function main() {
  const mongoUri = useProd
    ? process.env.PROD_MONGO_URL
    : process.env.MONGO_URL ||
      process.env.MONGODB_URI ||
      process.env.MONGO_URI ||
      process.env.PROD_MONGO_URL;
  if (!mongoUri) {
    throw new Error(
      useProd
        ? "Set PROD_MONGO_URL in .env (or pass --prod only when it is configured)"
        : "Set MONGO_URL, MONGODB_URI, MONGO_URI, or PROD_MONGO_URL in .env"
    );
  }
  console.log(`Connecting to ${useProd ? "PROD" : "default"} database…`);
  await mongoose.connect(mongoUri);

  const correlationId = `commission-backfill-${new Date().toISOString()}`;

  const dealers = await User.find({
    $or: [{ jobTitle: "DEALER" }, { role: "DEALER" }],
    isDisabled: { $ne: true },
  })
    .select("_id")
    .lean();

  const dealerIds = dealers.map((d) => d._id);
  console.log(`Found ${dealerIds.length} dealer users`);

  const ratesMap = await loadCommissionRatesMap();
  const filter = syncActivityOnly
    ? {
        salesPerson: { $in: dealerIds },
        commissionRatePerPlant: { $ne: null, $exists: true },
      }
    : {
        salesPerson: { $in: dealerIds },
        $or: [
          { commissionRatePerPlant: null },
          { commissionRatePerPlant: { $exists: false } },
        ],
      };

  let total = await Order.countDocuments(filter);
  console.log(
    `Orders to ${syncActivityOnly ? "sync activity for" : "backfill"}: ${total}${dryRun ? " (dry-run)" : ""}`
  );

  let processed = 0;
  let updated = 0;
  let skipped = 0;
  let eventsLogged = 0;

  const processBatch = async (orders) => {
    let batchUpdated = 0;
    for (const order of orders) {
      if (syncActivityOnly) {
        const existingEvent = await OrderEvent.findOne({
          idempotencyKey: migrationEventKey(order._id),
        })
          .select("_id")
          .lean();
        if (existingEvent) {
          skipped += 1;
          processed += 1;
          continue;
        }
      }

      const plantId =
        order.plantName?.toString?.() ?? String(order.plantName || "");
      const subtypeId =
        order.plantSubtype?.toString?.() ?? String(order.plantSubtype || "");
      const rate =
        ratesMap.get(`${plantId}_${subtypeId}`) ?? DEFAULT_COMMISSION_RATE;

      if (!syncActivityOnly && (!plantId || !subtypeId)) {
        skipped += 1;
        processed += 1;
        continue;
      }

      const result = await backfillOneOrder(order, rate, {
        correlationId,
        rateOnly: syncActivityOnly,
      });
      if (result.updated) {
        updated += 1;
        batchUpdated += 1;
      }
      if (result.eventEmitted) eventsLogged += 1;
      processed += 1;
    }
    return batchUpdated;
  };

  if (syncActivityOnly || dryRun) {
    const allOrders = await Order.find(filter)
      .select("_id orderId plantName plantSubtype commissionRatePerPlant")
      .lean();
    total = allOrders.length;
    for (let i = 0; i < allOrders.length; i += batchSize) {
      await processBatch(allOrders.slice(i, i + batchSize));
      console.log(
        `Progress: ${Math.min(i + batchSize, allOrders.length)}/${allOrders.length} ${dryRun ? "scanned" : "processed"}, ${updated} updated, ${eventsLogged} activity events, ${skipped} skipped`
      );
    }
  } else {
    while (processed < total) {
      const orders = await Order.find(filter)
        .select("_id orderId plantName plantSubtype commissionRatePerPlant")
        .limit(batchSize)
        .lean();

      if (orders.length === 0) break;

      await processBatch(orders);

      console.log(
        `Progress: ${processed}/${total} processed, ${updated} updated, ${eventsLogged} activity events, ${skipped} skipped`
      );
    }
  }

  console.log(
    JSON.stringify(
      {
        dryRun,
        useProd,
        syncActivityOnly,
        total,
        processed,
        updated,
        eventsLogged,
        skipped,
        correlationId,
      },
      null,
      2
    )
  );

  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

/**
 * Backfill OrderEvent for specific plant orders (e.g. after past-due rollover).
 *
 *   node scripts/backfill-order-events-for-orders.js --stage --orderId=252601749,252601754
 */

import dotenv from "dotenv";
import mongoose from "mongoose";
import path from "path";
import { fileURLToPath } from "url";
import Order from "../models/order.model.js";
import { emitPastDueRolloverTimelineEvents } from "../services/pastDueSlotRollover.service.js";
import { emitPlantOrderUpdateEvents } from "../utils/orderEventDualWrite.js";
import { buildDeliveryChangePayloads } from "../modules/orderEvents/events/mapEditHistoryToEvents.js";
import {
  ORDER_DOMAINS,
  ORDER_EVENT_SOURCE,
  buildIdempotencyKey,
  emitOrderEvent,
} from "../modules/orderEvents/index.js";
import OrderEvent from "../modules/orderEvents/models/orderEvent.model.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "..", ".env") });

const useStage = process.argv.includes("--stage");
const useProd = process.argv.includes("--prod");
const orderIdArg = process.argv.find((a) => a.startsWith("--orderId="));
const publicIds = orderIdArg
  ? orderIdArg
      .split("=")[1]
      .split(",")
      .map((s) => Number(s.trim()))
      .filter((n) => !Number.isNaN(n))
  : [];

const mongoUrl = useProd
  ? process.env.PROD_MONGO_URL
  : useStage
    ? process.env.STAGE_MONGO_URL
    : process.env.MONGO_URL;

if (!mongoUrl || !publicIds.length) {
  console.error("Usage: node scripts/backfill-order-events-for-orders.js --stage --orderId=252601749,...");
  process.exit(1);
}

async function backfillOne(lean) {
  const orderId = lean._id;
  let created = 0;

  const emitIfNew = async (payload, idempotencyKey) => {
    const existing = await OrderEvent.findOne({ idempotencyKey }).select("_id").lean();
    if (existing) return;
    await emitOrderEvent({
      ...payload,
      orderDomain: ORDER_DOMAINS.PLANT,
      orderId,
      idempotencyKey,
      source: ORDER_EVENT_SOURCE.MIGRATION,
    });
    created += 1;
  };

  const rolloverDc = [...(lean.deliveryChanges || [])]
    .reverse()
    .find((dc) => dc.reasonForChange === "Past due slot rollover");

  if (rolloverDc) {
    const at = rolloverDc.createdAt || lean.pastDueSlotRolloverAt || lean.updatedAt;
    await emitPastDueRolloverTimelineEvents(orderId, {
      deliveryChange: rolloverDc,
      occurredAt: at,
      slotLabel: `Past-due slot rollover (${lean.orderId})`,
    }).catch(() => {});

    const payloads = buildDeliveryChangePayloads(rolloverDc, {
      changedBy: rolloverDc.changedBy,
    });
    for (let i = 0; i < payloads.length; i++) {
      const p = payloads[i];
      await emitIfNew(
        {
          ...p,
          actorName: "Past-due slot rollover (backfill)",
          reason: rolloverDc.reasonForChange,
          occurredAt: at,
          refs: { legacySource: "pastDueRollover" },
        },
        buildIdempotencyKey("migration", "plant", "past-due", orderId, i, at?.getTime?.() || at)
      );
    }
  } else {
    await emitPlantOrderUpdateEvents({
      orderId,
      deliveryChange: null,
      editHistoryEntries: (lean.orderEditHistory || []).filter((e) =>
        String(e.notes || "").includes("Past-due slot rollover")
      ),
      actorName: "Past-due slot rollover (backfill)",
    });
  }

  return created;
}

async function main() {
  await mongoose.connect(mongoUrl);
  const orders = await Order.find({ orderId: { $in: publicIds } })
    .select(
      "orderId deliveryChanges orderEditHistory pastDueSlotRolloverAt pastDueSlotRollover updatedAt"
    )
    .lean();

  console.log(`Found ${orders.length}/${publicIds.length} orders`);
  let total = 0;
  for (const o of orders) {
    const n = await backfillOne(o);
    total += n;
    console.log(`  #${o.orderId}: timeline events synced`);
  }
  console.log(`Done. New migration events (approx): ${total}`);
  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

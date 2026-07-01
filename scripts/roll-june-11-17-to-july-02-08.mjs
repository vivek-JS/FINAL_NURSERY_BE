/**
 * Roll open-pipeline orders from 11-06–17-06 booking slots to 02-07–08-07 (same plant+subtype).
 * Preserves oldDeliveryDate, originalBookingSlot, deliveryChanges, slot trail (via rolloverOneOrder).
 *
 * Usage:
 *   NODE_ENV=production node scripts/roll-june-11-17-to-july-02-08.mjs --dry-run
 *   NODE_ENV=production node scripts/roll-june-11-17-to-july-02-08.mjs --execute
 */
import mongoose from "mongoose";
import "dotenv/config";
import PlantSlot from "../models/slots.model.js";
import Order from "../models/order.model.js";
import {
  deliveryDateForRolloverTarget,
  emitPastDueRolloverTimelineEvents,
  rolloverOneOrder,
} from "../services/pastDueSlotRollover.service.js";
import { DUE_DELIVERY_STATUSES } from "../utility/adminMisDue.js";

const SOURCE_START = "11-06-2026";
const SOURCE_END = "17-06-2026";
const TARGET_START = "02-07-2026";
const TARGET_END = "08-07-2026";

const execute = process.argv.includes("--execute");
const dryRun = !execute;

function orderPlants(order) {
  return (Number(order.numberOfPlants) || 0) + (Number(order.additionalPlants) || 0);
}

function slotWindowKey(slot) {
  return `${slot?.startDay}|${slot?.endDay}`;
}

function buildSourceTargetMaps(plantSlots) {
  const slotById = new Map();
  const targetByPsKey = new Map();

  for (const doc of plantSlots) {
    for (const subtypeSlot of doc.subtypeSlots || []) {
      const psKey = `${String(doc.plantId)}:${String(subtypeSlot.subtypeId)}`;
      let sourceMeta = null;
      let targetMeta = null;

      for (const slot of subtypeSlot.slots || []) {
        const slotId = slot._id?.toString?.() || String(slot._id);
        const base = {
          plantSlotId: doc._id,
          plantId: doc.plantId,
          plantSlotYear: doc.year,
          subtypeId: subtypeSlot.subtypeId,
          slot,
          slotId,
        };
        slotById.set(slotId, base);

        if (slot.startDay === SOURCE_START && slot.endDay === SOURCE_END) {
          sourceMeta = base;
        }
        if (slot.startDay === TARGET_START && slot.endDay === TARGET_END) {
          targetMeta = {
            ...base,
            deliveryDate: deliveryDateForRolloverTarget(slot, new Date(TARGET_END)),
          };
        }
      }

      if (sourceMeta && targetMeta) {
        targetByPsKey.set(psKey, { sourceMeta, targetMeta });
      }
    }
  }

  return { slotById, targetByPsKey };
}

async function main() {
  const mongoUrl =
    process.env.PROD_MONGO_URL ||
    process.env.MONGO_URL ||
    process.env.MONGODB_URI;
  if (!mongoUrl) throw new Error("Missing PROD_MONGO_URL / MONGO_URL");

  await mongoose.connect(mongoUrl);
  console.log(`Connected: ${mongoose.connection.name} (dryRun=${dryRun})`);

  const plantSlots = await PlantSlot.find({ year: 2026 })
    .select({
      plantId: 1,
      year: 1,
      "subtypeSlots.subtypeId": 1,
      "subtypeSlots.slots": 1,
    })
    .lean();

  const { slotById, targetByPsKey } = buildSourceTargetMaps(plantSlots);
  console.log(`Plant+subtype pairs with ${SOURCE_START}–${SOURCE_END} → ${TARGET_START}–${TARGET_END}:`, targetByPsKey.size);

  const sourceSlotIds = [];
  for (const { sourceMeta } of targetByPsKey.values()) {
    sourceSlotIds.push(new mongoose.Types.ObjectId(sourceMeta.slotId));
  }

  const eligibleMatch = {
    bookingSlot: { $in: sourceSlotIds },
    orderStatus: { $in: DUE_DELIVERY_STATUSES },
    $or: [{ quotaSource: { $ne: "dealer" } }, { quotaSource: { $exists: false } }],
    pastDueSlotRollover: { $ne: true },
  };

  const orders = await Order.find(eligibleMatch)
    .select(
      "_id orderId numberOfPlants additionalPlants bookingSlot deliveryDate orderStatus quotaSource productMappingId productName dispatchedFromAnotherSlot oldDeliveryDate originalBookingSlot pastDueSlotRollover"
    )
    .lean();

  console.log(`Eligible orders on source window: ${orders.length}`);

  const plan = [];
  for (const order of orders) {
    const bookingKey =
      order.bookingSlot?.toString?.() || String(order.bookingSlot || "");
    const sourceDetails = slotById.get(bookingKey);
    if (!sourceDetails) continue;

    const psKey = `${String(sourceDetails.plantId)}:${String(sourceDetails.subtypeId)}`;
    const pair = targetByPsKey.get(psKey);
    if (!pair) {
      plan.push({ orderId: order.orderId, skip: "NO_TARGET_SLOT", psKey });
      continue;
    }
    if (bookingKey === pair.targetMeta.slotId) {
      plan.push({ orderId: order.orderId, skip: "ALREADY_ON_TARGET" });
      continue;
    }

    plan.push({
      orderId: order.orderId,
      _id: String(order._id),
      status: order.orderStatus,
      plants: orderPlants(order),
      from: `${SOURCE_START}–${SOURCE_END}`,
      to: `${TARGET_START}–${TARGET_END}`,
      sourceDetails: {
        plantSlotId: pair.sourceMeta.plantSlotId,
        plantId: pair.sourceMeta.plantId,
        plantSlotYear: pair.sourceMeta.plantSlotYear,
        subtypeId: pair.sourceMeta.subtypeId,
        slot: pair.sourceMeta.slot,
      },
      targetMeta: pair.targetMeta,
      order,
    });
  }

  const toMove = plan.filter((p) => !p.skip);
  const skipped = plan.filter((p) => p.skip);
  const totalPlants = toMove.reduce((s, p) => s + (p.plants || 0), 0);

  console.log(`To move: ${toMove.length} orders, ${totalPlants} plants`);
  if (skipped.length) console.log(`Skipped: ${skipped.length}`, skipped.slice(0, 5));

  if (dryRun) {
    console.log("\nDry-run sample:");
    console.log(toMove.slice(0, 8).map((p) => ({
      orderId: p.orderId,
      status: p.status,
      plants: p.plants,
      to: p.to,
    })));
    await mongoose.disconnect();
    return;
  }

  let moved = 0;
  const errors = [];

  for (const row of toMove) {
    try {
      const session = await mongoose.startSession();
      let timelinePayload;
      try {
        await session.withTransaction(async () => {
          timelinePayload = await rolloverOneOrder(
            row.order,
            row.sourceDetails,
            row.targetMeta,
            session
          );
        });
      } finally {
        await session.endSession();
      }
      moved += 1;
      if (timelinePayload) {
        await emitPastDueRolloverTimelineEvents(row.order._id, timelinePayload).catch(
          (e) => console.error("timeline emit", row.orderId, e?.message)
        );
      }
      if (moved % 10 === 0) console.log(`Moved ${moved}/${toMove.length}...`);
    } catch (err) {
      errors.push({ orderId: row.orderId, reason: err?.message || String(err) });
      console.error("FAIL", row.orderId, err?.message);
    }
  }

  console.log(`\nDone. moved=${moved} errors=${errors.length}`);
  if (errors.length) console.log(errors);

  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

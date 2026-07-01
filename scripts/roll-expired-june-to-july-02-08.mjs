/**
 * Roll open-pipeline orders from expired June slot windows → 02-07–08-07 (same plant+subtype).
 * Includes already pastDueSlotRollover orders still on expired booking slots.
 *
 * Usage:
 *   NODE_ENV=production node scripts/roll-expired-june-to-july-02-08.mjs --dry-run
 *   NODE_ENV=production node scripts/roll-expired-june-to-july-02-08.mjs --execute
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

const SOURCE_WINDOWS = [
  { start: "11-06-2026", end: "17-06-2026" },
  { start: "18-06-2026", end: "24-06-2026" },
  { start: "25-06-2026", end: "01-07-2026" },
];
const TARGET_START = "02-07-2026";
const TARGET_END = "08-07-2026";

const execute = process.argv.includes("--execute");
const dryRun = !execute;

function orderPlants(order) {
  return (Number(order.numberOfPlants) || 0) + (Number(order.additionalPlants) || 0);
}

function buildSourceTargetMaps(plantSlots) {
  const slotById = new Map();
  /** psKey -> [{ sourceMeta, targetMeta, sourceWindow }] */
  const pairsByPsKey = new Map();

  for (const doc of plantSlots) {
    for (const subtypeSlot of doc.subtypeSlots || []) {
      const psKey = `${String(doc.plantId)}:${String(subtypeSlot.subtypeId)}`;
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

        if (slot.startDay === TARGET_START && slot.endDay === TARGET_END) {
          targetMeta = {
            ...base,
            deliveryDate: deliveryDateForRolloverTarget(slot, new Date(TARGET_END)),
          };
        }
      }

      if (!targetMeta) continue;

      for (const win of SOURCE_WINDOWS) {
        const sourceSlot = (subtypeSlot.slots || []).find(
          (s) => s.startDay === win.start && s.endDay === win.end
        );
        if (!sourceSlot) continue;

        const sourceMeta = {
          plantSlotId: doc._id,
          plantId: doc.plantId,
          plantSlotYear: doc.year,
          subtypeId: subtypeSlot.subtypeId,
          slot: sourceSlot,
          slotId: sourceSlot._id?.toString?.() || String(sourceSlot._id),
        };

        if (!pairsByPsKey.has(psKey)) pairsByPsKey.set(psKey, []);
        pairsByPsKey.get(psKey).push({
          sourceMeta,
          targetMeta,
          sourceWindow: `${win.start}–${win.end}`,
        });
      }
    }
  }

  return { slotById, pairsByPsKey };
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

  const { slotById, pairsByPsKey } = buildSourceTargetMaps(plantSlots);

  const sourceSlotIds = [];
  for (const pairs of pairsByPsKey.values()) {
    for (const p of pairs) {
      sourceSlotIds.push(new mongoose.Types.ObjectId(p.sourceMeta.slotId));
    }
  }

  const orders = await Order.find({
    bookingSlot: { $in: sourceSlotIds },
    orderStatus: { $in: DUE_DELIVERY_STATUSES },
    $or: [{ quotaSource: { $ne: "dealer" } }, { quotaSource: { $exists: false } }],
  })
    .select(
      "_id orderId numberOfPlants additionalPlants bookingSlot deliveryDate orderStatus quotaSource productMappingId productName dispatchedFromAnotherSlot oldDeliveryDate originalBookingSlot pastDueSlotRollover"
    )
    .lean();

  console.log(`Eligible orders on expired June booking slots: ${orders.length}`);

  const plan = [];
  for (const order of orders) {
    const bookingKey =
      order.bookingSlot?.toString?.() || String(order.bookingSlot || "");
    const sourceDetails = slotById.get(bookingKey);
    if (!sourceDetails) continue;

    const psKey = `${String(sourceDetails.plantId)}:${String(sourceDetails.subtypeId)}`;
    const pairs = pairsByPsKey.get(psKey) || [];
    const pair = pairs.find((p) => p.sourceMeta.slotId === bookingKey);
    if (!pair) continue;

    if (bookingKey === pair.targetMeta.slotId) {
      plan.push({ orderId: order.orderId, skip: "ALREADY_ON_TARGET" });
      continue;
    }

    plan.push({
      orderId: order.orderId,
      _id: String(order._id),
      status: order.orderStatus,
      plants: orderPlants(order),
      from: pair.sourceWindow,
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
  const byWindow = {};
  for (const p of toMove) {
    byWindow[p.from] = (byWindow[p.from] || 0) + 1;
  }
  const totalPlants = toMove.reduce((s, p) => s + (p.plants || 0), 0);

  console.log(`To move: ${toMove.length} orders, ${totalPlants} plants`);
  console.log("By source window:", byWindow);

  if (dryRun) {
    console.log("\nDry-run sample:");
    console.log(toMove.slice(0, 10).map((p) => ({
      orderId: p.orderId,
      status: p.status,
      plants: p.plants,
      from: p.from,
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

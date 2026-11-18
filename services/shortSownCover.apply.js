import mongoose from "mongoose";
import Order from "../models/order.model.js";
import SowingEntry from "../models/sowingEntry.model.js";
import SowingRequest from "../models/sowingRequest.model.js";
import PlantSlot from "../models/slots.model.js";
import { orderPlantRemaining, sowingStillShortExpr } from "./orderSowCover.plan.js";
import { planShortSownCover } from "./shortSownCover.plan.js";

const SLOT = "subtypeSlots.$[st].slots.$[sl]";
const BATCH = `${SLOT}.sowingBatches.$[b]`;
const DUMMY_AVAILABLE = 1000000;
const running = new Map();

const qty = (value) => Math.max(0, Math.floor(Number(value) || 0));
const oid = (value) =>
  value && mongoose.Types.ObjectId.isValid(String(value))
    ? new mongoose.Types.ObjectId(String(value))
    : null;

function offsetDays(delivery, readyText) {
  if (!delivery || !readyText) return 0;
  const del = new Date(delivery);
  const dmy = String(readyText).match(/^(\d{2})-(\d{2})-(\d{4})$/);
  if (!dmy || Number.isNaN(del.getTime())) return 0;
  const ready = new Date(Number(dmy[3]), Number(dmy[2]) - 1, Number(dmy[1]));
  return Math.round(
    (Date.UTC(del.getFullYear(), del.getMonth(), del.getDate()) -
      Date.UTC(ready.getFullYear(), ready.getMonth(), ready.getDate())) /
      86400000
  );
}

async function locateBatch(batchId) {
  const id = oid(batchId);
  if (!id) return null;
  const rows = await PlantSlot.aggregate([
    { $match: { "subtypeSlots.slots.sowingBatches._id": id } },
    { $unwind: "$subtypeSlots" },
    { $unwind: "$subtypeSlots.slots" },
    { $unwind: "$subtypeSlots.slots.sowingBatches" },
    { $match: { "subtypeSlots.slots.sowingBatches._id": id } },
    {
      $project: {
        slotId: "$subtypeSlots.slots._id",
        available: "$subtypeSlots.slots.availablePlants",
        excessive: "$subtypeSlots.slots.excessiveSowing.plants",
        slotMortality: "$subtypeSlots.slots.expectedMortality",
        batch: "$subtypeSlots.slots.sowingBatches",
      },
    },
    { $limit: 1 },
  ]);
  return rows[0] || null;
}

async function assignedByRequest(requestIds) {
  const ids = requestIds.map(oid).filter(Boolean);
  const assigned = new Map();
  if (!ids.length) return assigned;
  const rows = await Order.aggregate([
    {
      $match: {
        sowingCoverReversedAt: null,
        "sowingCoverSources.sowingRequestId": { $in: ids },
      },
    },
    { $unwind: "$sowingCoverSources" },
    { $match: { "sowingCoverSources.sowingRequestId": { $in: ids } } },
    {
      $group: {
        _id: "$sowingCoverSources.sowingRequestId",
        plants: { $sum: { $ifNull: ["$sowingCoverSources.plants", 0] } },
      },
    },
  ]);
  for (const row of rows) assigned.set(String(row._id), qty(row.plants));
  return assigned;
}

function poolFrom(entry, loc, assigned) {
  const batch = loc?.batch;
  const covered = qty(batch?.orderCoveredPlants ?? entry.orderCoveredPlants);
  const excess = qty(batch?.excessPlants ?? entry.excessPlants);
  const buffer = qty(batch?.bufferPlants ?? entry.bufferPlants);
  return {
    id: String(entry.sowingRequestId),
    entry,
    loc,
    ready: entry.plantReadyDate || "",
    plantsSowed: qty(entry.plantsSowed),
    unassigned: Math.max(0, covered - qty(assigned.get(String(entry.sowingRequestId)))),
    excess,
    buffer,
    noMortality: Boolean(entry.noMortalityReserve),
  };
}

function filters(slotId, batchId) {
  return [{ "st.slots._id": slotId }, { "sl._id": slotId }, { "b._id": batchId }];
}

async function moveStock(loc, { fromExcess, fromMortality, slotTake, mortalityOnSlot }) {
  const batchId = loc.batch._id;
  const slotId = loc.slotId;
  const inc = {};
  if (fromExcess + fromMortality > 0) inc[`${BATCH}.orderCoveredPlants`] = fromExcess + fromMortality;
  if (fromExcess > 0) {
    inc[`${BATCH}.excessPlants`] = -fromExcess;
    inc[`${BATCH}.shownExcess`] = -fromExcess;
  }
  if (fromMortality > 0) inc[`${BATCH}.bufferPlants`] = -fromMortality;
  if (slotTake > 0) {
    inc[`${SLOT}.availablePlants`] = -slotTake;
    inc[`${SLOT}.excessiveSowing.plants`] = -slotTake;
    inc[`${SLOT}.orderReservedPlants`] = slotTake;
    inc[`${BATCH}.orderReservedPlantsApplied`] = slotTake;
  }
  if (mortalityOnSlot > 0) inc[`${SLOT}.expectedMortality`] = -mortalityOnSlot;
  const moved = await PlantSlot.collection.updateOne(
    {
      subtypeSlots: {
        $elemMatch: {
          slots: {
            $elemMatch: {
              _id: slotId,
              ...(slotTake > 0
                ? {
                    availablePlants: { $gte: slotTake },
                    "excessiveSowing.plants": { $gte: slotTake },
                  }
                : {}),
              sowingBatches: {
                $elemMatch: {
                  _id: batchId,
                  ...(fromExcess > 0 ? { excessPlants: { $gte: fromExcess } } : {}),
                  ...(fromMortality > 0 ? { bufferPlants: { $gte: fromMortality } } : {}),
                },
              },
            },
          },
        },
      },
    },
    { $inc: inc },
    { arrayFilters: filters(slotId, batchId) }
  );
  if (!moved.modifiedCount) return false;
  if (fromMortality < 1) return true;
  const after = await locateBatch(batchId);
  const left = qty(after?.batch?.bufferPlants);
  const expected = qty(loc.batch.bufferPlants) - fromMortality;
  if (left <= expected) return true;
  const retry = await PlantSlot.collection.updateOne(
    { "subtypeSlots.slots.sowingBatches._id": batchId },
    { $inc: { [`${BATCH}.bufferPlants`]: -(left - expected) } },
    { arrayFilters: filters(slotId, batchId) }
  );
  return retry.modifiedCount > 0;
}

async function undoStock(loc, { fromExcess, fromMortality, slotTake, mortalityOnSlot }) {
  if (!loc?.batch?._id || !loc.slotId) return;
  const inc = {};
  if (fromExcess + fromMortality > 0) inc[`${BATCH}.orderCoveredPlants`] = -(fromExcess + fromMortality);
  if (fromExcess > 0) {
    inc[`${BATCH}.excessPlants`] = fromExcess;
    inc[`${BATCH}.shownExcess`] = fromExcess;
  }
  if (fromMortality > 0) inc[`${BATCH}.bufferPlants`] = fromMortality;
  if (slotTake > 0) {
    inc[`${SLOT}.availablePlants`] = slotTake;
    inc[`${SLOT}.excessiveSowing.plants`] = slotTake;
    inc[`${SLOT}.orderReservedPlants`] = -slotTake;
    inc[`${BATCH}.orderReservedPlantsApplied`] = -slotTake;
  }
  if (mortalityOnSlot > 0) inc[`${SLOT}.expectedMortality`] = mortalityOnSlot;
  if (!Object.keys(inc).length) return;
  await PlantSlot.collection.updateOne(
    { "subtypeSlots.slots.sowingBatches._id": loc.batch._id },
    { $inc: inc },
    { arrayFilters: filters(loc.slotId, loc.batch._id) }
  );
}

function coverRow(order, pool, take, slotTake) {
  const entry = pool.entry;
  const partialHold = qty(take.partialHold);
  const plants = take.plants + partialHold;
  return {
    slotId: pool.loc?.slotId || null,
    batchId: pool.loc?.batch?._id || entry.sourceBatchId || null,
    sowingRequestId: entry.sowingRequestId,
    requestNumber: entry.requestNumber || "",
    plants,
    sowingDate: entry.sowingDate || "",
    plantReadyDate: entry.plantReadyDate || "",
    shedName: entry.shedName || "",
    offsetDays: offsetDays(order.deliveryDate, entry.plantReadyDate),
    excessiveSowingDec: slotTake,
    availablePlantsDec: slotTake,
    batchExcessDec: take.fromStamp + take.fromExcess + take.fromMortality + partialHold,
    expectedMortalityDec: take.fromMortality,
    reservedOnSource: slotTake > 0 && slotTake === plants,
    moved: false,
  };
}

async function syncEntry(pool, take) {
  const fresh = pool.loc?.batch?._id ? await locateBatch(pool.loc.batch._id) : null;
  if (fresh) pool.loc = fresh;
  const batch = fresh?.batch;
  const covered = batch
    ? qty(batch.orderCoveredPlants)
    : qty(pool.entry.orderCoveredPlants) + take.fromExcess + take.fromMortality;
  const excess = batch
    ? qty(batch.excessPlants)
    : Math.max(0, qty(pool.entry.excessPlants) - take.fromExcess);
  const buffer = batch
    ? qty(batch.bufferPlants)
    : Math.max(0, qty(pool.entry.bufferPlants) - take.fromMortality);
  const covers = Array.isArray(pool.entry.orderCovers) ? pool.entry.orderCovers.map((row) => ({ ...row })) : [];
  const found = covers.find((row) => String(row.orderId) === String(pool.orderId));
  if (found) {
    found.plants = qty(found.plants) + take.plants;
    found.partial = false;
  } else {
    covers.push({ orderId: pool.orderId, plants: take.plants, partial: false });
  }
  const set = {
    orderCoveredPlants: covered,
    excessPlants: excess,
    orderCovers: covers,
  };
  if (take.fromMortality > 0) {
    set.bufferPlants = buffer;
    set.sowingBufferPct = pool.plantsSowed ? (buffer * 100) / pool.plantsSowed : 0;
  }
  await SowingEntry.updateOne(
    { _id: pool.entry._id },
    { $set: set, $addToSet: { linkedOrderIds: pool.orderId } }
  );
  pool.entry = { ...pool.entry, ...set, linkedOrderIds: pool.entry.linkedOrderIds };
  pool.excess = excess;
  pool.buffer = buffer;
  pool.unassigned = Math.max(0, pool.unassigned - take.fromStamp);
}

async function applyTake(order, pool, take) {
  const available = qty(pool.loc?.available);
  const excessive = qty(pool.loc?.excessive);
  const slotTake =
    take.fromExcess > 0 && available < DUMMY_AVAILABLE
      ? Math.min(take.fromExcess, available, excessive)
      : 0;
  const mortalityOnSlot =
    take.fromMortality > 0 && qty(pool.loc?.slotMortality) >= take.fromMortality
      ? take.fromMortality
      : 0;
  const moved = take.fromExcess + take.fromMortality > 0;
  if (moved && pool.loc?.batch?._id) {
    const ok = await moveStock(pool.loc, {
      fromExcess: take.fromExcess,
      fromMortality: take.fromMortality,
      slotTake,
      mortalityOnSlot,
    });
    if (!ok) return null;
  } else if (moved) {
    const nextBuffer = qty(pool.entry.bufferPlants) - take.fromMortality;
    const nextExcess = qty(pool.entry.excessPlants) - take.fromExcess;
    if (nextBuffer < 0 || nextExcess < 0) return null;
    await SowingEntry.updateOne(
      { _id: pool.entry._id },
      {
        $inc: {
          orderCoveredPlants: take.fromExcess + take.fromMortality,
          excessPlants: -take.fromExcess,
          bufferPlants: -take.fromMortality,
        },
      }
    );
  }
  const partialHere = (Array.isArray(order.sowingPartialCover) ? order.sowingPartialCover : [])
    .filter((row) => String(row?.requestId || "") === String(pool.entry.sowingRequestId))
    .reduce((sum, row) => sum + qty(row.plants), 0);
  const hasSource = (order.sowingCoverSources || []).some(
    (row) => String(row?.sowingRequestId || "") === String(pool.entry.sowingRequestId)
  );
  const partialHold = !hasSource && partialHere > 0 ? partialHere : 0;
  const row = coverRow(order, pool, { ...take, partialHold }, slotTake);
  const updated = await Order.findOneAndUpdate(
    { _id: order._id, sowingCoverReversedAt: null },
    {
      $push: { sowingCoverSources: row },
      ...(partialHere > 0 && !hasSource
        ? { $pull: { sowingPartialCover: { requestId: pool.entry.sowingRequestId } } }
        : {}),
      $set: { leftoverFromIncomplete: false },
    },
    { new: true }
  );
  if (!updated) {
    if (moved && pool.loc?.batch?._id) {
      await undoStock(pool.loc, {
        fromExcess: take.fromExcess,
        fromMortality: take.fromMortality,
        slotTake,
        mortalityOnSlot,
      });
    }
    return null;
  }
  const saved = updated.sowingCoverSources[updated.sowingCoverSources.length - 1];
  pool.orderId = order._id;
  await syncEntry(pool, take);
  await SowingRequest.updateOne(
    { _id: pool.entry.sowingRequestId },
    { $addToSet: { linkedOrderIds: order._id } }
  );
  if (pool.loc?.batch?._id && pool.loc.slotId) {
    await PlantSlot.collection.updateOne(
      { "subtypeSlots.slots.sowingBatches._id": pool.loc.batch._id },
      { $addToSet: { [`${BATCH}.linkedOrderIds`]: order._id } },
      { arrayFilters: filters(pool.loc.slotId, pool.loc.batch._id) }
    );
  }
  return {
    sourceId: saved?._id,
    fromStamp: take.fromStamp,
    fromExcess: take.fromExcess,
    fromMortality: take.fromMortality,
    plants: take.plants,
    slotTake,
    mortalityOnSlot,
    requestId: pool.entry.sowingRequestId,
  };
}

async function rollback(order, poolById, applied) {
  for (const step of applied.reverse()) {
    const pool = poolById.get(String(step.requestId));
    if (step.sourceId) {
      await Order.updateOne(
        { _id: order._id },
        { $pull: { sowingCoverSources: { _id: step.sourceId } } }
      );
    }
    if (pool?.loc && (step.fromExcess || step.fromMortality)) {
      await undoStock(pool.loc, step);
    }
    if (!pool) continue;
    pool.unassigned += qty(step.fromStamp);
    const fresh = pool.loc?.batch?._id ? await locateBatch(pool.loc.batch._id) : null;
    if (fresh?.batch) {
      pool.loc = fresh;
      pool.excess = qty(fresh.batch.excessPlants);
      pool.buffer = qty(fresh.batch.bufferPlants);
    } else {
      pool.excess += qty(step.fromExcess);
      pool.buffer += qty(step.fromMortality);
    }
    const covers = (pool.entry.orderCovers || [])
      .map((row) =>
        String(row.orderId) === String(order._id)
          ? { ...row, plants: qty(row.plants) - qty(step.plants) }
          : { ...row }
      )
      .filter((row) => qty(row.plants) > 0);
    const covered = fresh?.batch
      ? qty(fresh.batch.orderCoveredPlants)
      : Math.max(0, qty(pool.entry.orderCoveredPlants) - qty(step.fromExcess) - qty(step.fromMortality));
    await SowingEntry.updateOne(
      { _id: pool.entry._id },
      {
        $set: {
          orderCoveredPlants: covered,
          excessPlants: pool.excess,
          bufferPlants: pool.buffer,
          orderCovers: covers,
        },
      }
    );
    pool.entry = {
      ...pool.entry,
      orderCovers: covers,
      orderCoveredPlants: covered,
      excessPlants: pool.excess,
      bufferPlants: pool.buffer,
    };
  }
}

async function coverOne(order, pools) {
  const own = pools.find((pool) => pool.id === String(order.sowingDoneRequestId));
  if (!own) return null;
  const gap = orderPlantRemaining(order);
  const takes = planShortSownCover({ gap, own, sowings: pools });
  if (!takes) return null;
  const applied = [];
  const poolById = new Map(pools.map((pool) => [pool.id, pool]));
  let planned = 0;
  for (const take of takes) {
    const pool = poolById.get(String(take.id));
    if (!pool) return null;
    if (pool.noMortality) take.fromMortality = 0;
    take.plants = take.fromStamp + take.fromExcess + take.fromMortality;
    planned += take.plants;
  }
  if (planned !== gap) return null;
  for (const take of takes) {
    const pool = poolById.get(String(take.id));
    if (!pool) {
      await rollback(order, poolById, applied);
      return null;
    }
    if (pool.noMortality) take.fromMortality = 0;
    take.plants = take.fromStamp + take.fromExcess + take.fromMortality;
    if (
      take.fromStamp > pool.unassigned ||
      take.fromExcess > pool.excess ||
      take.fromMortality > pool.buffer ||
      take.plants < 1
    ) {
      await rollback(order, poolById, applied);
      return null;
    }
    const step = await applyTake(order, pool, take);
    if (!step) {
      await rollback(order, poolById, applied);
      return null;
    }
    applied.push(step);
  }
  return { orderId: order.orderId, plants: takes.reduce((sum, take) => sum + take.plants, 0) };
}

async function coverVariety({ plantId, subtypeId }) {
  const orders = await Order.find({
    plantName: oid(plantId) || plantId,
    plantSubtype: oid(subtypeId) || subtypeId,
    orderStatus: "ACCEPTED",
    sowingDone: true,
    sowingDoneRequestId: { $ne: null },
    sowingCoverReversedAt: null,
    dealerOrder: { $ne: true },
    $expr: sowingStillShortExpr(),
  })
    .select(
      "orderId numberOfPlants additionalPlants deliveryDate sowingDoneRequestId sowingCoverSources sowingPartialCover"
    )
    .lean();
  if (!orders.length) return [];
  const entries = await SowingEntry.find({
    plantId: oid(plantId) || plantId,
    subtypeId: oid(subtypeId) || subtypeId,
    isIrrelevant: { $ne: true },
    entryKind: { $nin: ["komb", "excess"] },
  }).lean();
  const assigned = await assignedByRequest(entries.map((entry) => entry.sowingRequestId));
  const pools = [];
  for (const entry of entries) {
    if (!entry.sowingRequestId) continue;
    const loc = await locateBatch(entry.sourceBatchId);
    const pool = poolFrom(entry, loc, assigned);
    if (pool.noMortality) pool.buffer = 0;
    pools.push(pool);
  }
  orders.sort((a, b) => orderPlantRemaining(a) - orderPlantRemaining(b) || a.orderId - b.orderId);
  const covered = [];
  for (const order of orders) {
    const result = await coverOne(order, pools);
    if (result) covered.push(result);
  }
  return covered;
}

/** Cover sown-but-short orders of one variety. Same variety cannot run twice at once. */
export function coverShortSownOrders({ plantId, subtypeId }) {
  if (!plantId || !subtypeId) return Promise.resolve([]);
  const key = `${plantId}:${subtypeId}`;
  const existing = running.get(key);
  if (existing) return existing;
  const job = coverVariety({ plantId, subtypeId }).finally(() => running.delete(key));
  running.set(key, job);
  return job;
}

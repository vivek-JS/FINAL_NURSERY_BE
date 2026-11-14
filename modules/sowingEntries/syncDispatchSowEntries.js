import mongoose from "mongoose";
import SowingEntry from "../../models/sowingEntry.model.js";
import { sowDayFrom } from "./mapSowingEntry.js";
import { keepMarkedOld } from "./saveSowingEntry.js";
import { sellablePlantsOf } from "../../services/sowBatchStock.service.js";

const intQty = (v) => Math.max(0, Math.floor(Number(v) || 0));
const idStr = (v) => (v == null || v === "" ? "" : String(v?._id ?? v));

function oid(value) {
  const text = idStr(value);
  return mongoose.Types.ObjectId.isValid(text) ? new mongoose.Types.ObjectId(text) : null;
}

/** Bookable excess the dispatch just stamped on the batch. */
export function bookableExcessOf(batch) {
  if (!batch || batch.isIrrelevant) return 0;
  if (batch.shownExcess != null && batch.shownExcess !== "") {
    return intQty(batch.shownExcess);
  }
  return intQty(batch.excessPlants);
}

function touch(map, batchId, orderId) {
  const batch = idStr(batchId);
  const order = idStr(orderId);
  if (!batch || !order) return;
  if (!map.has(batch)) map.set(batch, new Set());
  map.get(batch).add(order);
}

function stillOnBatch(sources, batchId) {
  return (sources || []).some(
    (src) => idStr(src?.moved ? src.destBatchId : src?.batchId) === idStr(batchId) && intQty(src?.plants) > 0
  );
}

/**
 * Which orders leave a sowing entry and which land on the one the shed picked.
 * Multiple picks are one line each.
 */
export function dispatchEntryLinkAdjustments(lines, sourcesByOrder = new Map()) {
  const add = new Map();
  const pull = new Map();
  const batchIds = new Set();
  const picked = new Set(
    (lines || []).map((line) => `${idStr(line.orderId)}|${idStr(line.batchId)}`)
  );
  const note = (batchId) => {
    const id = idStr(batchId);
    if (id) batchIds.add(id);
  };
  const pullUnlessPicked = (batchId, orderId) => {
    if (picked.has(`${idStr(orderId)}|${idStr(batchId)}`)) return;
    touch(pull, batchId, orderId);
  };

  for (const line of lines || []) {
    note(line.batchId);
    if (line.bucket !== "COVER") touch(add, line.batchId, line.orderId);
    for (const rel of line.released || []) {
      note(rel.batchId);
      pullUnlessPicked(rel.batchId, line.orderId);
    }
    for (const rh of line.coverRehome || []) {
      note(rh.fromBatchId);
      const sources = sourcesByOrder.get(idStr(line.orderId)) || [];
      if (stillOnBatch(sources, rh.fromBatchId)) touch(add, rh.fromBatchId, line.orderId);
      else pullUnlessPicked(rh.fromBatchId, line.orderId);
    }
    for (const rl of line.relinks || []) {
      note(rl.fromBatchId);
      note(rl.toBatchId);
      pullUnlessPicked(rl.fromBatchId, rl.orderId);
      touch(add, rl.toBatchId, rl.orderId);
    }
    for (const take of line.unlinkedTakes || []) {
      note(take.fromBatchId);
      pullUnlessPicked(take.fromBatchId, take.orderId);
    }
  }
  return { add, pull, batchIds };
}

function linkedIdsFor(batch, batchId, add, pull) {
  const ids = new Set((batch?.linkedOrderIds || []).map(idStr).filter(Boolean));
  for (const id of add.get(batchId) || []) ids.add(id);
  for (const id of pull.get(batchId) || []) ids.delete(id);
  return [...ids].map(oid).filter(Boolean);
}

/** Fields written onto one sowingentries document from the batch dispatch just saved. */
export function sowingEntryDispatchSet(batch, batchId, add, pull) {
  return {
    orderCoveredPlants: intQty(batch?.orderCoveredPlants),
    excessPlants: bookableExcessOf(batch),
    linkedOrderIds: linkedIdsFor(batch, batchId, add, pull),
    plantsSowed: intQty(batch?.plantsSowed),
    // A blank batch % is not 0%. Ready plants are the only rows that clear CMS mortality.
    ...(batch?.noMortalityReserve
      ? { bufferPlants: 0, sowingBufferPct: 0 }
      : {
          ...(batch?.bufferPlants == null ? {} : { bufferPlants: intQty(batch.bufferPlants) }),
          ...(batch?.sowingBufferPct == null
            ? {}
            : { sowingBufferPct: Math.max(0, Number(batch.sowingBufferPct) || 0) }),
        }),
    mortalityMovedToExcess: intQty(batch?.mortalityMovedToExcess),
    excessMovedToMortality: intQty(batch?.excessMovedToMortality),
    noMortalityReserve: Boolean(batch?.noMortalityReserve),
    isIrrelevant: Boolean(batch?.isIrrelevant),
    requestNumber: batch?.requestNumber || "",
    shedName: batch?.shedName || "",
    plantReadyDate: batch?.plantReadyDate || "",
    out: batch?.out || "",
    sowingDate: batch?.sowingDate || "",
    sowDay: sowDayFrom(batch?.sowingDate),
  };
}

/** Plants this save put on the vehicle from one batch. */
export function plantsLoadedOnBatch(lines, batchId) {
  const id = String(batchId || "");
  let plants = 0;
  for (const line of lines || []) {
    if (String(line?.batchId || "") !== id) continue;
    const n = Math.floor(Number(line?.plants) || 0);
    if (n > 0) plants += n;
  }
  return plants;
}

function orderKey(value) {
  return String(value?._id || value || "");
}

/**
 * Add or remove plants on the orders this sowing dispatched to.
 * A positive change is a load. A negative change is an unload.
 */
export function applyDispatchOrderPlants(stored, changes) {
  const map = new Map();
  for (const row of stored || []) {
    const id = orderKey(row?.orderId);
    const plants = Math.floor(Number(row?.plants) || 0);
    if (id && plants > 0) map.set(id, plants);
  }
  for (const change of changes || []) {
    const id = orderKey(change?.orderId);
    if (!id) continue;
    const next = (map.get(id) || 0) + Math.floor(Number(change?.plants) || 0);
    if (next > 0) map.set(id, next);
    else map.delete(id);
  }
  return [...map.entries()].map(([orderId, plants]) => ({ orderId, plants }));
}

/** Plants each order took from this batch on the current load. */
export function dispatchOrderChanges(lines, batchId) {
  const id = String(batchId || "");
  const map = new Map();
  for (const line of lines || []) {
    if (String(line?.batchId || "") !== id) continue;
    const plants = Math.floor(Number(line?.plants) || 0);
    const orderId = orderKey(line?.orderId);
    if (!orderId || plants <= 0) continue;
    map.set(orderId, (map.get(orderId) || 0) + plants);
  }
  return [...map.entries()].map(([orderId, plants]) => ({ orderId, plants }));
}

/**
 * Plants that left a sowing on this vehicle load.
 * Cover stays where it was. Only Dispatched, remaining, and the Out list change.
 */
export async function recordSowingEntryPlantDispatch({ session, lines }) {
  const batchIds = [
    ...new Set((lines || []).map((line) => idStr(line?.batchId)).filter(Boolean)),
  ];
  const sourceIds = batchIds.map((id) => oid(id)).filter(Boolean);
  if (!sourceIds.length) return { updated: 0 };
  const storedRows = await SowingEntry.find({ sourceBatchId: { $in: sourceIds } })
    .select(
      "sourceBatchId dispatchedPlants dispatchedOrders plantsSowed bufferPlants sowingBufferPct mortalityMovedToExcess excessMovedToMortality noMortalityReserve isIrrelevant"
    )
    .session(session || null)
    .lean();
  const ops = [];
  for (const row of storedRows) {
    const batchId = String(row.sourceBatchId);
    const added = plantsLoadedOnBatch(lines, batchId);
    if (added < 1) continue;
    const nextOut = Math.max(0, Math.floor(Number(row.dispatchedPlants) || 0)) + added;
    ops.push({
      updateOne: {
        filter: { sourceBatchId: row.sourceBatchId },
        update: {
          $set: {
            dispatchedPlants: nextOut,
            remainingPlants: sellablePlantsOf(row) - nextOut,
            dispatchedOrders: applyDispatchOrderPlants(
              row.dispatchedOrders,
              dispatchOrderChanges(lines, batchId)
            ),
          },
        },
      },
    });
  }
  if (!ops.length) return { updated: 0 };
  await SowingEntry.bulkWrite(ops, { session });
  return { updated: ops.length };
}

/**
 * After a sowing-allowed vehicle load, copy cover, excess, and order links
 * onto the sowing entries the shed changed. Old slot batches stay as they are.
 */
export async function syncDispatchSowEntries({
  session,
  batchIndex,
  lines,
  sourcesByOrder,
  plantId,
  subtypeId,
  plantName = "",
  subtypeName = "",
  year = null,
}) {
  const { add, pull, batchIds } = dispatchEntryLinkAdjustments(lines, sourcesByOrder);
  const sourceIds = [...batchIds].map((id) => oid(id)).filter(Boolean);
  const storedRows = sourceIds.length
    ? await SowingEntry.find({ sourceBatchId: { $in: sourceIds } })
        .select("sourceBatchId dispatchedPlants dispatchedOrders isIrrelevant")
        .session(session || null)
        .lean()
    : [];
  const storedByBatch = new Map(storedRows.map((row) => [String(row.sourceBatchId), row]));
  const plantOid = oid(plantId);
  const subtypeOid = oid(subtypeId);
  const ops = [];
  for (const batchId of batchIds) {
    const found = batchIndex?.get(batchId);
    const batch = found?.batch;
    const sourceBatchId = oid(batch?._id || batchId);
    if (!batch || !sourceBatchId || !plantOid) continue;
    const insert = {
      sourceBatchId,
      plantId: plantOid,
      plantName: String(plantName || ""),
      subtypeName: String(subtypeName || ""),
    };
    if (subtypeOid) insert.subtypeId = subtypeOid;
    if (year != null && year !== "") insert.year = Number(year) || undefined;
    const requestId = oid(batch.sowingRequestId);
    if (requestId) insert.sowingRequestId = requestId;
    const stored = storedByBatch.get(String(sourceBatchId));
    const set = keepMarkedOld(
      sowingEntryDispatchSet(batch, batchId, add, pull),
      stored?.isIrrelevant
    );
    const nextOut =
      Math.max(0, Math.floor(Number(stored?.dispatchedPlants) || 0)) + plantsLoadedOnBatch(lines, batchId);
    set.dispatchedPlants = nextOut;
    set.remainingPlants = sellablePlantsOf(batch) - nextOut;
    set.dispatchedOrders = applyDispatchOrderPlants(
      stored?.dispatchedOrders,
      dispatchOrderChanges(lines, batchId)
    );
    ops.push({
      updateOne: {
        filter: { sourceBatchId },
        update: {
          $set: set,
          $setOnInsert: insert,
        },
        upsert: true,
      },
    });
  }
  if (!ops.length) return { updated: 0 };
  await SowingEntry.bulkWrite(ops, { session });
  return { updated: ops.length };
}

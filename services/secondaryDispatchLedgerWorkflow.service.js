import mongoose from "mongoose";
import {
  SECONDARY_DISPATCH_LEDGER_ACTIONS,
  SECONDARY_DISPATCH_LEDGER_COLLECTIONS,
  buildDispatchEvent,
  buildDispatchIdempotencyKey,
  buildDispatchLedgerLines,
  computeDispatchDeltas,
} from "../utils/secondaryDispatchLedger.js";

const LOAD = SECONDARY_DISPATCH_LEDGER_ACTIONS.LOAD;
const UNLOAD = SECONDARY_DISPATCH_LEDGER_ACTIONS.UNLOAD;

function toId(v) {
  return v == null ? null : String(v).trim() || null;
}

function toInt(v) {
  return Math.max(0, Math.floor(Number(v) || 0));
}

function col(name) {
  return mongoose.connection.collection(name);
}

function nowIso() {
  return new Date().toISOString();
}

/**
 * Ensure indexes exist for ledger collections.
 * Safe to call on boot.
 */
export async function ensureSecondaryDispatchLedgerIndexes() {
  const events = col(SECONDARY_DISPATCH_LEDGER_COLLECTIONS.EVENTS);
  const lines = col(SECONDARY_DISPATCH_LEDGER_COLLECTIONS.LINES);
  await Promise.all([
    events.createIndex({ dispatchId: 1, createdAt: -1 }),
    events.createIndex({ requestHash: 1 }),
    events.createIndex({ idempotencyKey: 1 }, { unique: true }),
    lines.createIndex({ eventId: 1 }),
    lines.createIndex({ dispatchId: 1, createdAt: -1 }),
    lines.createIndex({ linkedOrderId: 1, createdAt: -1 }),
    lines.createIndex({ batchId: 1, createdAt: -1 }),
    lines.createIndex({ secondaryInwardId: 1, createdAt: -1 }),
    lines.createIndex({ secondaryOutwardId: 1, createdAt: -1 }),
    lines.createIndex({ linkedBookingSlotId: 1, createdAt: -1 }),
  ]);
}

function shapeAllocations(action, rawAllocations, ctx = {}) {
  const out = [];
  for (const a of rawAllocations || []) {
    const plants = toInt(a?.plants);
    if (!(plants > 0)) continue;
    out.push({
      dispatchId: toId(ctx.dispatchId),
      linkedOrderId: toId(a?.linkedOrderId ?? ctx.linkedOrderId),
      batchId: toId(a?.batchId),
      batchNumber: toId(a?.batchNumber),
      secondaryInwardId: toId(a?.secondaryInwardId),
      secondaryOutwardId: toId(a?.secondaryOutwardId),
      linkedBookingSlotId: toId(a?.linkedBookingSlotId),
      plantRowIndex: Number.isFinite(Number(ctx.plantRowIndex))
        ? Number(ctx.plantRowIndex)
        : null,
      cavity: toInt(a?.cavity) || null,
      size: toId(a?.size),
      pollyhouse: toId(a?.pollyhouse),
      remarks: toId(ctx.remarks),
      plants,
      action,
    });
  }
  if (!out.length) {
    throw new Error("No valid allocations to record in dispatch ledger");
  }
  return out;
}

/**
 * Transactionally persist ledger event + lines and return computed deltas.
 *
 * @param {{
 *   action: "LOAD"|"UNLOAD",
 *   dispatchId: string,
 *   requestPayload: Record<string, unknown>,
 *   resolvedAllocations: Record<string, unknown>[],
 *   linkedOrderId?: string|null,
 *   plantRowIndex?: number|null,
 *   remarks?: string|null,
 *   createdBy?: string|null,
 *   traceId?: string|null,
 *   session?: import("mongoose").ClientSession
 * }} params
 */
export async function recordSecondaryDispatchLedger(params) {
  const action = params?.action;
  if (action !== LOAD && action !== UNLOAD) {
    throw new Error(`Unsupported dispatch action: ${action}`);
  }
  const dispatchId = toId(params?.dispatchId);
  if (!dispatchId) throw new Error("dispatchId required");

  const ownSession = !params?.session;
  const session = params?.session || (await mongoose.startSession());
  try {
    if (ownSession) session.startTransaction();

    const requestPayload =
      params?.requestPayload && typeof params.requestPayload === "object"
        ? params.requestPayload
        : {};

    const idempotencyKey = buildDispatchIdempotencyKey({
      dispatchId,
      action,
      payload: requestPayload,
    });

    const events = col(SECONDARY_DISPATCH_LEDGER_COLLECTIONS.EVENTS);
    const linesCol = col(SECONDARY_DISPATCH_LEDGER_COLLECTIONS.LINES);

    const existing = await events.findOne({ idempotencyKey }, { session });
    if (existing) {
      const existingLines = await linesCol
        .find({ eventId: existing.eventId }, { session })
        .toArray();
      return {
        reused: true,
        event: existing,
        lines: existingLines,
        deltas: computeDispatchDeltas(existingLines),
      };
    }

    const allocations = shapeAllocations(action, params?.resolvedAllocations, {
      dispatchId,
      linkedOrderId: params?.linkedOrderId,
      plantRowIndex: params?.plantRowIndex,
      remarks: params?.remarks,
    });

    const createdAt = nowIso();
    const event = buildDispatchEvent({
      action,
      dispatchId,
      requestPayload,
      resolvedAllocations: allocations,
      createdBy: params?.createdBy,
      createdAt,
      traceId: params?.traceId,
    });
    event.idempotencyKey = idempotencyKey;

    const lines = buildDispatchLedgerLines(event, allocations);

    await events.insertOne(event, { session });
    if (lines.length) await linesCol.insertMany(lines, { session });

    if (ownSession) await session.commitTransaction();

    return {
      reused: false,
      event,
      lines,
      deltas: computeDispatchDeltas(lines),
    };
  } catch (err) {
    if (ownSession) await session.abortTransaction();
    throw err;
  } finally {
    if (ownSession) await session.endSession();
  }
}

/**
 * Query ledger lines with common filters.
 * @param {{
 *   dispatchId?: string,
 *   linkedOrderId?: string,
 *   batchId?: string,
 *   secondaryInwardId?: string,
 *   secondaryOutwardId?: string,
 *   linkedBookingSlotId?: string,
 *   action?: "LOAD"|"UNLOAD",
 *   from?: string,
 *   to?: string,
 *   page?: number,
 *   limit?: number
 * }} filter
 */
export async function querySecondaryDispatchLedgerLines(filter = {}) {
  const q = {};
  if (toId(filter.dispatchId)) q.dispatchId = toId(filter.dispatchId);
  if (toId(filter.linkedOrderId)) q.linkedOrderId = toId(filter.linkedOrderId);
  if (toId(filter.batchId)) q.batchId = toId(filter.batchId);
  if (toId(filter.secondaryInwardId)) q.secondaryInwardId = toId(filter.secondaryInwardId);
  if (toId(filter.secondaryOutwardId)) q.secondaryOutwardId = toId(filter.secondaryOutwardId);
  if (toId(filter.linkedBookingSlotId)) q.linkedBookingSlotId = toId(filter.linkedBookingSlotId);
  if (filter.action === LOAD || filter.action === UNLOAD) q.action = filter.action;

  if (filter.from || filter.to) {
    q.createdAt = {};
    if (filter.from) q.createdAt.$gte = new Date(filter.from).toISOString();
    if (filter.to) q.createdAt.$lte = new Date(filter.to).toISOString();
  }

  const page = Math.max(1, Number(filter.page) || 1);
  const limit = Math.min(200, Math.max(1, Number(filter.limit) || 50));
  const skip = (page - 1) * limit;

  const linesCol = col(SECONDARY_DISPATCH_LEDGER_COLLECTIONS.LINES);
  const [items, total] = await Promise.all([
    linesCol.find(q).sort({ createdAt: -1 }).skip(skip).limit(limit).toArray(),
    linesCol.countDocuments(q),
  ]);
  return {
    items,
    page,
    limit,
    total,
    totalPages: Math.max(1, Math.ceil(total / limit)),
  };
}

/**
 * Compute aggregate totals for a set of line filters.
 * @param {Parameters<typeof querySecondaryDispatchLedgerLines>[0]} filter
 */
export async function summarizeSecondaryDispatchLedger(filter = {}) {
  const q = {};
  if (toId(filter.dispatchId)) q.dispatchId = toId(filter.dispatchId);
  if (toId(filter.linkedOrderId)) q.linkedOrderId = toId(filter.linkedOrderId);
  if (toId(filter.batchId)) q.batchId = toId(filter.batchId);
  if (toId(filter.secondaryInwardId)) q.secondaryInwardId = toId(filter.secondaryInwardId);
  if (toId(filter.secondaryOutwardId)) q.secondaryOutwardId = toId(filter.secondaryOutwardId);
  if (toId(filter.linkedBookingSlotId)) q.linkedBookingSlotId = toId(filter.linkedBookingSlotId);
  if (filter.action === LOAD || filter.action === UNLOAD) q.action = filter.action;
  if (filter.from || filter.to) {
    q.createdAt = {};
    if (filter.from) q.createdAt.$gte = new Date(filter.from).toISOString();
    if (filter.to) q.createdAt.$lte = new Date(filter.to).toISOString();
  }

  const linesCol = col(SECONDARY_DISPATCH_LEDGER_COLLECTIONS.LINES);
  const rows = await linesCol
    .aggregate([
      { $match: q },
      {
        $group: {
          _id: null,
          lineCount: { $sum: 1 },
          plantsAbs: { $sum: "$plantsAbs" },
          plantsDelta: { $sum: "$plantsDelta" },
          slotDelta: { $sum: "$slotDelta" },
          loadAbs: {
            $sum: {
              $cond: [{ $eq: ["$action", LOAD] }, "$plantsAbs", 0],
            },
          },
          unloadAbs: {
            $sum: {
              $cond: [{ $eq: ["$action", UNLOAD] }, "$plantsAbs", 0],
            },
          },
        },
      },
    ])
    .toArray();
  const agg = rows[0] || {};
  return {
    lineCount: toInt(agg.lineCount),
    plantsAbs: toInt(agg.plantsAbs),
    plantsDelta: Number(agg.plantsDelta || 0),
    slotDelta: Number(agg.slotDelta || 0),
    loadAbs: toInt(agg.loadAbs),
    unloadAbs: toInt(agg.unloadAbs),
  };
}

/**
 * Example counter patch object derived from ledger deltas.
 * Caller can apply these to domain models in same transaction.
 * @param {ReturnType<typeof computeDispatchDeltas>} deltas
 */
export function buildCounterPatchSet(deltas) {
  return {
    dispatchIncs: deltas.byDispatch || {},
    orderIncs: deltas.byOrder || {},
    secondaryInwardIncs: deltas.bySecondaryInward || {},
    slotIncs: deltas.bySlot || {},
    batchIncs: deltas.byBatch || {},
  };
}

/**
 * Apply computed counter deltas through caller-supplied domain update hooks.
 * Keeps this service decoupled from project-specific model names.
 *
 * @param {{
 *   deltas: ReturnType<typeof computeDispatchDeltas>,
 *   session?: import("mongoose").ClientSession,
 *   hooks: {
 *     incDispatchLoaded?: (dispatchId: string, delta: number, session?: import("mongoose").ClientSession) => Promise<void>,
 *     incOrderShedLoaded?: (orderId: string, delta: number, session?: import("mongoose").ClientSession) => Promise<void>,
 *     incSecondaryInwardRemaining?: (secondaryInwardId: string, delta: number, session?: import("mongoose").ClientSession) => Promise<void>,
 *     incSlotActualDispatched?: (slotId: string, delta: number, session?: import("mongoose").ClientSession) => Promise<void>,
 *     incBatchDispatched?: (batchId: string, delta: number, session?: import("mongoose").ClientSession) => Promise<void>,
 *   }
 * }} params
 */
export async function applySecondaryDispatchCounterPatch(params) {
  const deltas = params?.deltas || {};
  const hooks = params?.hooks || {};
  const session = params?.session;

  for (const [dispatchId, delta] of Object.entries(deltas.byDispatch || {})) {
    if (!delta || !hooks.incDispatchLoaded) continue;
    await hooks.incDispatchLoaded(dispatchId, Number(delta), session);
  }
  for (const [orderId, delta] of Object.entries(deltas.byOrder || {})) {
    if (!delta || !hooks.incOrderShedLoaded) continue;
    await hooks.incOrderShedLoaded(orderId, Number(delta), session);
  }
  for (const [secondaryInwardId, delta] of Object.entries(deltas.bySecondaryInward || {})) {
    if (!delta || !hooks.incSecondaryInwardRemaining) continue;
    await hooks.incSecondaryInwardRemaining(secondaryInwardId, Number(delta), session);
  }
  for (const [slotId, delta] of Object.entries(deltas.bySlot || {})) {
    if (!delta || !hooks.incSlotActualDispatched) continue;
    await hooks.incSlotActualDispatched(slotId, Number(delta), session);
  }
  for (const [batchId, delta] of Object.entries(deltas.byBatch || {})) {
    if (!delta || !hooks.incBatchDispatched) continue;
    await hooks.incBatchDispatched(batchId, Number(delta), session);
  }
}


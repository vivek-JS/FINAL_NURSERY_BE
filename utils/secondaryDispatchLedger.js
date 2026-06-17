import crypto from "crypto";

const LOAD = "LOAD";
const UNLOAD = "UNLOAD";

function nowIso() {
  return new Date().toISOString();
}

function toInt(v) {
  return Math.max(0, Math.floor(Number(v) || 0));
}

function asId(v) {
  return v == null ? null : String(v).trim() || null;
}

function stableStringify(obj) {
  if (obj == null || typeof obj !== "object") return JSON.stringify(obj);
  if (Array.isArray(obj)) return `[${obj.map((x) => stableStringify(x)).join(",")}]`;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

function payloadHash(payload) {
  return crypto.createHash("sha256").update(stableStringify(payload)).digest("hex");
}

function ensureAction(action) {
  if (action !== LOAD && action !== UNLOAD) {
    throw new Error(`Unsupported ledger action: ${action}`);
  }
}

/**
 * Validate inward selections from load payload.
 * @param {{inwardSelections?: unknown[]}} body
 * @returns {{secondaryInwardId: string, batchId: string|null, plants: number}[]}
 */
export function normalizeInwardSelections(body) {
  const list = Array.isArray(body?.inwardSelections) ? body.inwardSelections : [];
  if (!list.length) throw new Error("inwardSelections required");
  const out = [];
  for (const row of list) {
    const secondaryInwardId = asId(row?.secondaryInwardId);
    const batchId = asId(row?.batchId);
    const plants = toInt(row?.plants);
    if (!secondaryInwardId) throw new Error("secondaryInwardId required for each inward selection");
    if (!(plants > 0)) throw new Error("plants must be > 0 for each inward selection");
    out.push({ secondaryInwardId, batchId, plants });
  }
  return out;
}

/**
 * Build immutable event envelope that stores request + resolved allocations.
 * @param {{
 *   action: "LOAD"|"UNLOAD",
 *   dispatchId: string,
 *   requestPayload: Record<string, unknown>,
 *   resolvedAllocations: Record<string, unknown>[],
 *   createdBy?: string|null,
 *   createdAt?: string,
 *   traceId?: string|null
 * }} input
 */
export function buildDispatchEvent(input) {
  ensureAction(input?.action);
  const dispatchId = asId(input?.dispatchId);
  if (!dispatchId) throw new Error("dispatchId required");
  const requestPayload = input?.requestPayload && typeof input.requestPayload === "object"
    ? input.requestPayload
    : {};
  const resolvedAllocations = Array.isArray(input?.resolvedAllocations) ? input.resolvedAllocations : [];
  if (!resolvedAllocations.length) throw new Error("resolvedAllocations required");
  const createdAt = input?.createdAt || nowIso();
  return {
    eventId: crypto.randomUUID(),
    action: input.action,
    dispatchId,
    traceId: asId(input?.traceId),
    requestPayload,
    requestHash: payloadHash(requestPayload),
    resolvedAllocations,
    allocationHash: payloadHash(resolvedAllocations),
    createdBy: asId(input?.createdBy),
    createdAt,
  };
}

/**
 * Convert event allocations into append-only normalized ledger lines.
 * @param {{
 *   eventId: string,
 *   action: "LOAD"|"UNLOAD",
 *   dispatchId: string,
 *   createdAt?: string
 * }} event
 * @param {Record<string, unknown>[]} allocations
 */
export function buildDispatchLedgerLines(event, allocations) {
  ensureAction(event?.action);
  if (!event?.eventId) throw new Error("eventId required");
  const createdAt = event.createdAt || nowIso();
  const sign = event.action === LOAD ? 1 : -1;
  const lines = [];
  for (const alloc of allocations || []) {
    const plants = toInt(alloc?.plants);
    if (!(plants > 0)) continue;
    const slotLinked = Boolean(asId(alloc?.linkedBookingSlotId));
    lines.push({
      ledgerLineId: crypto.randomUUID(),
      eventId: event.eventId,
      action: event.action,
      dispatchId: event.dispatchId,
      linkedOrderId: asId(alloc?.linkedOrderId),
      batchId: asId(alloc?.batchId),
      batchNumber: asId(alloc?.batchNumber),
      secondaryInwardId: asId(alloc?.secondaryInwardId),
      secondaryOutwardId: asId(alloc?.secondaryOutwardId),
      linkedBookingSlotId: asId(alloc?.linkedBookingSlotId),
      plantRowIndex: Number.isFinite(Number(alloc?.plantRowIndex))
        ? Number(alloc.plantRowIndex)
        : null,
      plantsAbs: plants,
      plantsDelta: plants * sign,
      slotDelta: slotLinked ? plants * -sign : 0,
      metadata: {
        cavity: toInt(alloc?.cavity) || null,
        size: asId(alloc?.size),
        pollyhouse: asId(alloc?.pollyhouse),
        remarks: asId(alloc?.remarks),
      },
      createdAt,
    });
  }
  if (!lines.length) throw new Error("No valid ledger lines from allocations");
  return lines;
}

function upsertCounter(map, key, delta) {
  if (!key || !delta) return;
  map.set(key, (map.get(key) || 0) + delta);
}

/**
 * Aggregate balance changes from normalized ledger lines.
 * Use these deltas inside one DB transaction.
 * @param {ReturnType<typeof buildDispatchLedgerLines>} lines
 */
export function computeDispatchDeltas(lines) {
  const byDispatch = new Map();
  const byOrder = new Map();
  const bySecondaryInward = new Map();
  const bySlot = new Map();
  const byBatch = new Map();
  for (const ln of lines || []) {
    upsertCounter(byDispatch, ln.dispatchId, ln.plantsDelta);
    upsertCounter(byOrder, ln.linkedOrderId, ln.plantsDelta);
    upsertCounter(bySecondaryInward, ln.secondaryInwardId, -ln.plantsDelta);
    upsertCounter(bySlot, ln.linkedBookingSlotId, ln.slotDelta);
    upsertCounter(byBatch, ln.batchId, ln.plantsDelta);
  }
  return {
    byDispatch: Object.fromEntries(byDispatch),
    byOrder: Object.fromEntries(byOrder),
    bySecondaryInward: Object.fromEntries(bySecondaryInward),
    bySlot: Object.fromEntries(bySlot),
    byBatch: Object.fromEntries(byBatch),
  };
}

/**
 * Build outward selections for UNLOAD from previously loaded ledger lines.
 * @param {{secondaryOutwardId?: string|null, plants: number}[]} unloadRows
 */
export function normalizeUnloadSelections(unloadRows) {
  const rows = Array.isArray(unloadRows) ? unloadRows : [];
  if (!rows.length) throw new Error("outwardSelections required for unload");
  return rows.map((r) => {
    const secondaryOutwardId = asId(r?.secondaryOutwardId);
    const plants = toInt(r?.plants);
    if (!secondaryOutwardId) throw new Error("secondaryOutwardId required for unload rows");
    if (!(plants > 0)) throw new Error("plants must be > 0 for unload rows");
    return { secondaryOutwardId, plants };
  });
}

/**
 * Build idempotency key to prevent duplicate load/unload effects.
 * @param {{dispatchId: string, action: "LOAD"|"UNLOAD", payload: unknown}} args
 */
export function buildDispatchIdempotencyKey(args) {
  ensureAction(args?.action);
  const dispatchId = asId(args?.dispatchId);
  if (!dispatchId) throw new Error("dispatchId required");
  const h = payloadHash(args?.payload ?? {});
  return `${dispatchId}:${args.action}:${h}`;
}

/**
 * Suggested collection names for this module.
 */
export const SECONDARY_DISPATCH_LEDGER_COLLECTIONS = {
  EVENTS: "secondarydispatchledgerevents",
  LINES: "secondarydispatchledgerlines",
};

export const SECONDARY_DISPATCH_LEDGER_ACTIONS = { LOAD, UNLOAD };

import OrderEvent from "../models/orderEvent.model.js";
import {
  APPROVAL_STATUS,
  DEFAULT_TENANT_ID,
  ORDER_EVENT_SOURCE,
  SENSITIVE_ORDER_EVENT_TYPES,
} from "../domain/constants.js";
import {
  buildEventPayloadFromEditEntry,
  buildStatusChangePayload,
} from "./mapEditHistoryToEvents.js";

export function buildIdempotencyKey(...parts) {
  return parts.filter((p) => p != null && p !== "").join(":");
}

function normalizeApproval(approval = {}) {
  return {
    required: Boolean(approval.required),
    status: approval.status || APPROVAL_STATUS.NA,
    requestId: approval.requestId || undefined,
  };
}

/**
 * Append-only operational order event (idempotent by tenantId + idempotencyKey).
 */
export async function emitOrderEvent(
  {
    tenantId = DEFAULT_TENANT_ID,
    orderDomain,
    orderId,
    eventType,
    idempotencyKey,
    field,
    previousValue,
    newValue,
    description,
    actorId,
    actorName,
    reason,
    approval = {},
    refs = {},
    correlationId,
    metadata,
    occurredAt = new Date(),
    source = ORDER_EVENT_SOURCE.LIVE,
  },
  { session, strict = false } = {}
) {
  if (!orderDomain || !orderId || !eventType || !idempotencyKey) {
    if (strict) {
      throw new Error("emitOrderEvent requires orderDomain, orderId, eventType, idempotencyKey");
    }
    return null;
  }

  if (SENSITIVE_ORDER_EVENT_TYPES.has(eventType) && !String(reason || "").trim()) {
    if (strict) {
      throw new Error(`emitOrderEvent requires reason for sensitive event ${eventType}`);
    }
    console.warn(`[OrderEvent] Missing reason for sensitive event ${eventType} on order ${orderId}`);
  }

  try {
    const existingQ = OrderEvent.findOne({ tenantId, idempotencyKey }).select("_id").lean();
    if (session) existingQ.session(session);
    const existing = await existingQ;
    if (existing) return existing;

    const doc = {
      tenantId,
      orderDomain,
      orderId,
      eventType,
      idempotencyKey,
      field,
      previousValue,
      newValue,
      description,
      actorId,
      actorName,
      reason: reason ? String(reason).slice(0, 2000) : undefined,
      approval: normalizeApproval(approval),
      refs,
      correlationId,
      metadata,
      occurredAt: occurredAt instanceof Date ? occurredAt : new Date(occurredAt),
      source,
    };

    if (session) {
      const [created] = await OrderEvent.create([doc], { session });
      return created;
    }
    return await OrderEvent.create(doc);
  } catch (err) {
    if (err?.code === 11000) {
      const dup = await OrderEvent.findOne({ tenantId, idempotencyKey }).lean();
      if (dup) return dup;
    }
    console.error("[OrderEvent] emit failed:", idempotencyKey, err?.message || err);
    if (strict) throw err;
    return null;
  }
}

export async function emitOrderEventsFromEditHistory(
  {
    orderDomain,
    orderId,
    entries = [],
    actorId,
    actorName,
    correlationId,
    tenantId = DEFAULT_TENANT_ID,
    reason,
    source = ORDER_EVENT_SOURCE.LIVE,
  },
  { session } = {}
) {
  const results = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const payload = buildEventPayloadFromEditEntry(entry);
    const ts = entry.createdAt ? new Date(entry.createdAt).getTime() : Date.now();
    const key = buildIdempotencyKey(
      orderDomain.toLowerCase(),
      "edit",
      orderId,
      entry.field,
      ts,
      i
    );
    const created = await emitOrderEvent(
      {
        tenantId,
        orderDomain,
        orderId,
        ...payload,
        actorId: actorId || payload.actorId,
        actorName,
        reason: reason || entry.reason,
        correlationId,
        occurredAt: entry.createdAt || new Date(),
        source,
        idempotencyKey: key,
        description: payload.description,
      },
      { session }
    );
    if (created) results.push(created);
  }
  return results;
}

export async function emitOrderStatusChangeEvent(
  {
    orderDomain,
    orderId,
    previousStatus,
    newStatus,
    changedBy,
    actorName,
    reason,
    correlationId,
    tenantId = DEFAULT_TENANT_ID,
    source = ORDER_EVENT_SOURCE.LIVE,
  },
  { session } = {}
) {
  const payload = buildStatusChangePayload({
    previousStatus,
    newStatus,
    changedBy,
    reason,
  });
  const key = buildIdempotencyKey(
    orderDomain.toLowerCase(),
    "status",
    orderId,
    previousStatus,
    newStatus,
    Date.now()
  );
  return emitOrderEvent(
    {
      tenantId,
      orderDomain,
      orderId,
      ...payload,
      actorId: changedBy,
      actorName,
      correlationId,
      source,
      idempotencyKey: key,
    },
    { session }
  );
}

export function emitOrderEventShadow(params, options = {}) {
  const run = () =>
    emitOrderEvent(params, { session: options.session, strict: false }).catch((e) => {
      console.error("[OrderEvent] shadow emit error:", e?.message || e);
    });
  if (options.awaitResult) return run();
  setImmediate(run);
  return undefined;
}

export async function emitOrderEventShadowAwait(params, options = {}) {
  return emitOrderEvent(params, { session: options.session, strict: false });
}

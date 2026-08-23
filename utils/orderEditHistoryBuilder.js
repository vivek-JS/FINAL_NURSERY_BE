/**
 * Build orderEditHistory entries and merge into Mongo update payloads.
 * Used by updateOrder (factory) and dispatch order sync paths.
 */

const FIELD_CONFIG = {
  orderStatus: { label: "Status" },
  rate: { label: "Rate", numeric: true },
  numberOfPlants: { label: "Quantity", numeric: true },
  deliveryDate: { label: "Delivery date", date: true },
  bookingSlot: { label: "Booking slot", objectId: true },
  plantSubtype: { label: "Plant subtype", objectId: true },
  salesPerson: { label: "Sales person", objectId: true },
  orderPaymentStatus: { label: "Payment status" },
  notes: { label: "Notes" },
  farmReadyDate: { label: "Farm ready date", date: true },
  dispatchDayKey: { label: "Dispatch day" },
  dispatchTargetDate: { label: "Dispatch target date", date: true },
  cavity: { label: "Tray / cavity", objectId: true },
  expectedNursery: { label: "Expected nursery" },
  batchNumber: { label: "Batch number" },
  freightCharges: { label: "Freight charges", numeric: true },
  freight: { label: "Freight split" },
  deliveryChallanInvoiceNumber: { label: "DC invoice label" },
  orderFor: { label: "Order for" },
  farmer: { label: "Farmer", objectId: true },
  remainingPlants: { label: "Remaining plants", numeric: true },
  returnedPlants: { label: "Returned plants", numeric: true },
  damagedPlants: { label: "Damaged plants", numeric: true },
  additionalPlants: { label: "Additional plants", numeric: true },
};

function normalizeRoleKey(r) {
  if (r == null || r === "") return "";
  return String(r).trim();
}

function formatDateEnIn(value) {
  if (value == null || value === "") return "—";
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleDateString("en-IN");
}

function normalizeForCompare(field, value, config = {}) {
  if (value === undefined) return undefined;
  if (value === null || value === "") {
    return config.numeric ? null : "";
  }
  if (config.numeric) {
    const n = Number(value);
    return Number.isFinite(n) ? n : value;
  }
  if (config.date) {
    const d = value instanceof Date ? value : new Date(value);
    return Number.isNaN(d.getTime()) ? String(value) : d.toISOString();
  }
  if (config.objectId) {
    return String(value?._id || value);
  }
  if (typeof value === "object") {
    return JSON.stringify(value);
  }
  return String(value).trim();
}

export function editValuesEqual(field, previousValue, nextValue) {
  const config = FIELD_CONFIG[field] || {};
  const prev = normalizeForCompare(field, previousValue, config);
  const next = normalizeForCompare(field, nextValue, config);
  if (prev === undefined && next === undefined) return true;
  return prev === next;
}

/**
 * @param {object} params
 * @param {object} params.existingDoc
 * @param {object} params.pendingSet - fields going into $set on update
 * @param {import("mongoose").Types.ObjectId | string | null} [params.userId]
 * @param {Set<string>} [params.skipFields] - already logged manually
 * @param {(field: string, prev: unknown, next: unknown) => string | undefined} [params.notesForField]
 */
export function buildOrderEditHistoryEntries({
  existingDoc,
  pendingSet,
  userId = null,
  skipFields = new Set(),
  notesForField,
}) {
  const entries = [];
  if (!existingDoc || !pendingSet) return entries;

  for (const field of Object.keys(FIELD_CONFIG)) {
    if (skipFields.has(field)) continue;
    if (!Object.prototype.hasOwnProperty.call(pendingSet, field)) continue;

    const previousValue = existingDoc[field];
    const newValue = pendingSet[field];
    if (editValuesEqual(field, previousValue, newValue)) continue;

    const config = FIELD_CONFIG[field];
    let notes =
      (typeof notesForField === "function" &&
        notesForField(field, previousValue, newValue)) ||
      undefined;

    if (!notes) {
      const label = config.label || field;
      if (config.date) {
        notes = `${label} changed from ${formatDateEnIn(previousValue)} to ${formatDateEnIn(newValue)}`;
      } else if (config.numeric) {
        notes = `${label} changed from ${previousValue ?? "—"} to ${newValue ?? "—"}`;
      } else {
        notes = `${label} changed from ${previousValue ?? "—"} to ${newValue ?? "—"}`;
      }
    }

    entries.push({
      field,
      previousValue: previousValue === undefined ? "" : previousValue,
      // Schema requires newValue; Mixed + required rejects null/undefined.
      newValue: newValue === null || newValue === undefined ? "" : newValue,
      changedBy: userId || null,
      notes,
    });
  }

  return entries;
}

/** Merge entries into filteredBody.$push.orderEditHistory */
export function mergeEditHistoryIntoFilteredBody(filteredBody, entries) {
  if (!entries?.length) return;
  if (!filteredBody.$push) filteredBody.$push = {};
  if (!filteredBody.$push.orderEditHistory) {
    filteredBody.$push.orderEditHistory = { $each: [...entries] };
  } else if (filteredBody.$push.orderEditHistory.$each) {
    filteredBody.$push.orderEditHistory.$each.push(...entries);
  } else {
    const first = filteredBody.$push.orderEditHistory;
    filteredBody.$push.orderEditHistory = { $each: [first, ...entries] };
  }
}

/**
 * Diff two order documents after an update (e.g. dispatch flow).
 */
export function buildOrderEditHistoryFromDocDiff(
  previousDoc,
  updatedDoc,
  { userId = null, skipFields = new Set(), reasonPrefix = "" } = {}
) {
  if (!previousDoc || !updatedDoc) return [];
  const pendingSet = {};
  for (const field of Object.keys(FIELD_CONFIG)) {
    if (skipFields.has(field)) continue;
    if (!editValuesEqual(field, previousDoc[field], updatedDoc[field])) {
      pendingSet[field] = updatedDoc[field];
    }
  }
  const entries = buildOrderEditHistoryEntries({
    existingDoc: previousDoc,
    pendingSet,
    userId,
    skipFields,
    notesForField: (field, prev, next) => {
      const label = FIELD_CONFIG[field]?.label || field;
      const prefix = reasonPrefix ? `${reasonPrefix}: ` : "";
      if (FIELD_CONFIG[field]?.date) {
        return `${prefix}${label} changed from ${formatDateEnIn(prev)} to ${formatDateEnIn(next)}`;
      }
      return `${prefix}${label} changed from ${prev ?? "—"} to ${next ?? "—"}`;
    },
  });
  return entries;
}

export function getOrderEditHistoryFieldLabels() {
  const out = {};
  for (const [key, cfg] of Object.entries(FIELD_CONFIG)) {
    out[key] = cfg.label;
  }
  return out;
}

/** Fire admin WhatsApp for each queued order edit (after DB transaction commit). */
export async function fireOrderEditWhatsAppAlerts(queue, changedBy = "Unknown") {
  if (!queue?.length) return;
  const { sendOrderEditedAlert, filterEditHistoryForWhatsAppAlert } = await import(
    "../services/whatsappAlertService.js"
  );
  const { evaluateOrderAlertsOnUpdate } = await import(
    "../services/whatsappAlertEngine.service.js"
  );
  for (const item of queue) {
    try {
      const alertableEntries = filterEditHistoryForWhatsAppAlert(item.entries);
      if (alertableEntries.length === 0) continue;

      const plain = item.updatedOrder?.toObject?.() ?? item.updatedOrder;
      await sendOrderEditedAlert(plain, changedBy, alertableEntries, item.previousOrder);
      await evaluateOrderAlertsOnUpdate(plain, alertableEntries);
    } catch (err) {
      console.error(
        "[orderEditHistory] WhatsApp alert failed:",
        err?.message || err
      );
    }
  }
}

export { FIELD_CONFIG as ORDER_EDIT_HISTORY_FIELD_CONFIG, formatDateEnIn };

export { fieldToOrderEventType } from "../modules/orderEvents/events/mapEditHistoryToEvents.js";

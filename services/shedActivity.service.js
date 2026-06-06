import mongoose from "mongoose";
import moment from "moment";
import PlantOutward from "../models/plantOutward.model.js";
import SecondaryDispatchAvailability from "../models/secondaryDispatchAvailability.model.js";

export const SHED_ACTIVITY_ACTIONS = {
  PRIMARY_INWARD_RECORDED: "PRIMARY_INWARD_RECORDED",
  PRIMARY_OUTWARD_RECORDED: "PRIMARY_OUTWARD_RECORDED",
  PRIMARY_READINESS_BYPASS: "PRIMARY_READINESS_BYPASS",
  PRIMARY_READINESS_BYPASS_CLEARED: "PRIMARY_READINESS_BYPASS_CLEARED",
  SECONDARY_ACCEPT: "SECONDARY_ACCEPT",
  SECONDARY_LAGWAD_RECORDED: "SECONDARY_LAGWAD_RECORDED",
  SECONDARY_SLOT_LINKED: "SECONDARY_SLOT_LINKED",
  SECONDARY_READY_DATE_SET: "SECONDARY_READY_DATE_SET",
  SECONDARY_READINESS_BYPASS: "SECONDARY_READINESS_BYPASS",
  SECONDARY_READINESS_BYPASS_CLEARED: "SECONDARY_READINESS_BYPASS_CLEARED",
  SECONDARY_SLOT_SYNC: "SECONDARY_SLOT_SYNC",
  SECONDARY_SLOT_RELOCATE: "SECONDARY_SLOT_RELOCATE",
  SECONDARY_MORTALITY: "SECONDARY_MORTALITY",
  SECONDARY_OUTWARD: "SECONDARY_OUTWARD",
};

/**
 * Append activity to primaryInward or secondaryInward subdoc.
 */
export async function recordShedActivity({
  batchId,
  stage = "secondary_inward",
  subdocId,
  action,
  activityName,
  performedBy,
  quantity = 0,
  previousValue = null,
  newValue = null,
  reason = "",
  metadata = null,
  session = null,
}) {
  if (!batchId || !subdocId || !action) return null;

  const entry = {
    action,
    activityName: activityName || action,
    performedAt: new Date(),
    quantity: Math.max(0, Number(quantity) || 0),
    previousValue,
    newValue,
    reason: String(reason || "").slice(0, 500),
    metadata,
  };
  if (performedBy && mongoose.isValidObjectId(String(performedBy))) {
    entry.performedBy = performedBy;
  }

  const path =
    stage === "primary_inward" ? "primaryInward" : "secondaryInward";
  const idField = stage === "primary_inward" ? "primaryInwardId" : "secondaryInwardId";

  await PlantOutward.updateOne(
    { batchId, [`${path}._id`]: subdocId },
    { $push: { [`${path}.$.activityLog`]: entry } },
    { session: session || undefined }
  );

  return { ...entry, [idField]: String(subdocId) };
}

function formatDateLabel(d) {
  if (!d) return "—";
  const m = moment(d);
  return m.isValid() ? m.format("DD MMM YYYY") : "—";
}

function normalizeActivityEntry(raw, ctx) {
  const at = raw.performedAt || raw.createdAt || raw.transferDate || new Date();
  return {
    id: String(raw._id || `${ctx.source}-${at}-${raw.action || "evt"}`),
    at: new Date(at).toISOString(),
    stage: ctx.stage,
    action: raw.action || ctx.fallbackAction || "EVENT",
    activityName: raw.activityName || raw.remarks || ctx.fallbackAction || "Activity",
    labelMr: raw.activityName || raw.remarks || "",
    quantity: Number(raw.quantity ?? raw.quantityTransferred) || 0,
    performedBy: raw.performedBy ?? null,
    before: raw.previousValue ?? null,
    after: raw.newValue ?? null,
    reason: raw.reason || "",
    metadata: raw.metadata || null,
    refs: {
      primaryInwardId: ctx.primaryInwardId ? String(ctx.primaryInwardId) : null,
      secondaryInwardId: ctx.secondaryInwardId ? String(ctx.secondaryInwardId) : null,
      linkedBookingSlotId: ctx.linkedBookingSlotId ? String(ctx.linkedBookingSlotId) : null,
      slotLabel: ctx.slotLabel || null,
    },
  };
}

/**
 * Merge activityLog, transferHistory, and ledger trail into one timeline.
 */
export async function buildShedActivityTimeline(batchId, { secondaryInwardId } = {}) {
  const po = await PlantOutward.findOne({ batchId })
    .populate("primaryInward.activityLog.performedBy", "name phoneNumber")
    .populate("secondaryInward.activityLog.performedBy", "name phoneNumber")
    .lean();
  if (!po) return [];

  const events = [];

  for (const pi of po.primaryInward || []) {
    if (secondaryInwardId) continue;
    const pid = String(pi._id);
    for (const log of pi.activityLog || []) {
      events.push(
        normalizeActivityEntry(log, {
          source: "pi-log",
          stage: "primary_inward",
          primaryInwardId: pid,
          fallbackAction: log.action,
        })
      );
    }
    for (const th of pi.transferHistory || []) {
      events.push(
        normalizeActivityEntry(
          {
            ...th,
            action: "TRANSFER",
            activityName: `Primary inward transfer · ${th.quantityTransferred || 0} plants`,
            quantity: th.quantityTransferred,
          },
          { source: "pi-th", stage: "primary_inward", primaryInwardId: pid }
        )
      );
    }
  }

  for (const si of po.secondaryInward || []) {
    const sid = String(si._id);
    if (secondaryInwardId && sid !== String(secondaryInwardId)) continue;
    const slotLabel = si.expectedReadyDate
      ? formatDateLabel(si.expectedReadyDate)
      : null;
    for (const log of si.activityLog || []) {
      events.push(
        normalizeActivityEntry(log, {
          source: "si-log",
          stage: "secondary_inward",
          secondaryInwardId: sid,
          linkedBookingSlotId: si.linkedBookingSlotId,
          slotLabel,
          fallbackAction: log.action,
        })
      );
    }
    for (const th of si.transferHistory || []) {
      events.push(
        normalizeActivityEntry(
          {
            ...th,
            action: "TRANSFER",
            activityName: `Secondary transfer · ${th.quantityTransferred || 0} plants`,
            quantity: th.quantityTransferred,
          },
          {
            source: "si-th",
            stage: "secondary_inward",
            secondaryInwardId: sid,
            linkedBookingSlotId: si.linkedBookingSlotId,
            slotLabel,
          }
        )
      );
    }
  }

  const ledger = await SecondaryDispatchAvailability.findOne({
    dispatchBatchId: batchId,
  }).lean();
  if (ledger?.availabilityTrail?.length && !secondaryInwardId) {
    for (const t of ledger.availabilityTrail) {
      events.push(
        normalizeActivityEntry(
          {
            ...t,
            performedAt: t.createdAt,
            activityName: t.activityName || t.action,
          },
          {
            source: "ledger",
            stage: "secondary_ledger",
            secondaryInwardId: t.secondaryInwardId,
            fallbackAction: t.action,
          }
        )
      );
    }
  }

  events.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
  return events;
}

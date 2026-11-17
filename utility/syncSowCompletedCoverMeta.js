/**
 * Keep SOW_COMPLETED event.meta cover/excess in line with the live batch.
 * Excess / mortality cover updates the batch; without this the sow log keeps
 * the old snapshot and the UI can still show leftover excess.
 */
import mongoose from "mongoose";

const intQty = (v) => Math.max(0, Math.floor(Number(v) || 0));

function oid(id) {
  if (!id) return null;
  if (id instanceof mongoose.Types.ObjectId) return id;
  const s = String(id?._id || id);
  return mongoose.Types.ObjectId.isValid(s) ? new mongoose.Types.ObjectId(s) : null;
}

/**
 * @param {import("mongodb").Db} db
 */
export async function syncSowCompletedCoverMeta(
  db,
  {
    requestId,
    orderCoveredPlants,
    excessPlants,
    ordersMarked = null,
    remainingUncovered = null,
    reason = "",
  } = {}
) {
  const reqOid = oid(requestId);
  if (!reqOid || !db) return { updated: false, reason: "no_request" };

  const req = await db.collection("sowingrequests").findOne(
    { _id: reqOid },
    { projection: { completionEvents: 1, requestNumber: 1 } }
  );
  if (!req) return { updated: false, reason: "missing" };

  const events = Array.isArray(req.completionEvents) ? req.completionEvents : [];
  const idx = events.findIndex((e) => e?.type === "SOW_COMPLETED");
  if (idx < 0) return { updated: false, reason: "no_sow_completed" };

  const cover = intQty(orderCoveredPlants);
  const excess = intQty(excessPlants);
  const rem = remainingUncovered == null ? excess : intQty(remainingUncovered);
  const prev = events[idx]?.meta || {};
  const same =
    intQty(prev.orderCoveredPlants) === cover &&
    intQty(prev.excessPlants) === excess &&
    intQty(prev.remainingUncovered) === rem &&
    (ordersMarked == null || intQty(prev.ordersMarked) === intQty(ordersMarked));
  if (same) return { updated: false, reason: "unchanged", cover, excess };

  const meta = {
    ...prev,
    orderCoveredPlants: cover,
    excessPlants: excess,
    remainingUncovered: rem,
  };
  if (ordersMarked != null) meta.ordersMarked = intQty(ordersMarked);
  if (reason) meta.coverMetaSyncedReason = String(reason).slice(0, 200);
  meta.coverMetaSyncedAt = new Date().toISOString();

  await db.collection("sowingrequests").updateOne(
    { _id: reqOid },
    { $set: { [`completionEvents.${idx}.meta`]: meta } }
  );
  return {
    updated: true,
    requestNumber: req.requestNumber || "",
    cover,
    excess,
    index: idx,
  };
}

/** Read live batch stamps and sync the sow-completed meta for that request. */
export async function syncSowCompletedMetaFromBatch(
  db,
  { requestId, batch, linkedOrderCount = null, reason = "" } = {}
) {
  if (!batch) return { updated: false, reason: "no_batch" };
  const cover = intQty(batch.orderCoveredPlants);
  const excess = intQty(
    batch.shownExcess != null ? batch.shownExcess : batch.excessPlants
  );
  return syncSowCompletedCoverMeta(db, {
    requestId: requestId || batch.sowingRequestId,
    orderCoveredPlants: cover,
    excessPlants: excess,
    remainingUncovered: excess,
    ordersMarked: linkedOrderCount,
    reason,
  });
}

/**
 * Order status audit trail for analytics (daily dispatch / pipeline reports).
 *
 * `findByIdAndUpdate` / `updateMany` do not run Mongoose document `pre("save")` hooks,
 * so `statusChanges` must be appended explicitly whenever `orderStatus` changes via raw updates.
 */

/**
 * Merge a statusChanges entry into a Mongo update document that uses `$set.orderStatus`.
 * No-op if next status equals previous or orderStatus is not in `$set`.
 *
 * @param {object} updateOperation - e.g. `{ $set: { orderStatus, ... }, $push: { ... } }`
 * @param {string} previousStatus - current DB value before this update
 * @param {{ userId?: import("mongoose").Types.ObjectId, reason?: string }} [options]
 * @returns {object}
 */
export function appendStatusChangeToUpdate(
  updateOperation,
  previousStatus,
  options = {}
) {
  if (!updateOperation || previousStatus == null) return updateOperation;

  const nextStatus =
    updateOperation.$set && Object.prototype.hasOwnProperty.call(
      updateOperation.$set,
      "orderStatus"
    )
      ? updateOperation.$set.orderStatus
      : undefined;

  if (nextStatus === undefined) return updateOperation;
  if (String(nextStatus) === String(previousStatus)) return updateOperation;

  const { userId, reason } = options;
  const entry = {
    previousStatus,
    newStatus: nextStatus,
  };
  if (userId) entry.changedBy = userId;
  if (reason) entry.reason = String(reason).slice(0, 500);

  const out = { ...updateOperation };
  out.$push = { ...(out.$push || {}), statusChanges: entry };
  return out;
}

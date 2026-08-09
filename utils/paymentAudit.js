/** Stamp audit fields on embedded order/agri payment subdocuments. */

export function resolvePaymentActorId(user) {
  if (!user) return null;
  const id = user._id ?? user.id;
  return id != null && String(id).trim() ? id : null;
}

export function stampPaymentRecordedBy(payment, user) {
  if (!payment) return;
  const actorId = resolvePaymentActorId(user);
  if (actorId) payment.paymentRecordedBy = actorId;
}

export function stampPaymentUpdatedBy(payment, user) {
  if (!payment) return;
  const actorId = resolvePaymentActorId(user);
  if (actorId) payment.paymentUpdatedBy = actorId;
}

/** Map populated user doc to a small API shape for dashboards. */
export function mapPaymentActorUser(user) {
  if (!user) return null;
  const name = String(user.name || "").trim();
  if (!name) return null;
  return {
    _id: user._id != null ? String(user._id) : undefined,
    name,
    phoneNumber: user.phoneNumber != null ? String(user.phoneNumber) : "",
    role: String(user.jobTitle || user.role || "").trim() || undefined,
  };
}

/** Aggregation helper: build { name, phoneNumber, role } from $lookup user array. */
export function paymentActorFromLookupArrayExpr(userArrayField) {
  return {
    $let: {
      vars: { u: { $arrayElemAt: [userArrayField, 0] } },
      in: {
        $cond: [
          { $and: [{ $ne: ["$$u", null] }, { $ne: ["$$u.name", null] }, { $ne: ["$$u.name", ""] }] },
          {
            _id: "$$u._id",
            name: "$$u.name",
            phoneNumber: { $ifNull: ["$$u.phoneNumber", ""] },
            role: { $ifNull: ["$$u.jobTitle", { $ifNull: ["$$u.role", ""] }] },
          },
          null,
        ],
      },
    },
  };
}

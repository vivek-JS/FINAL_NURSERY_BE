import Order from "../models/order.model.js";

/**
 * Linked orders on a cancelled SR go back to unsown (and drop this request's partial hold).
 */
export async function releaseOrdersLinkedToSowingRequest(request) {
  if (!request?._id) return { modifiedCount: 0 };
  const rid = request._id;
  const linked = (request.linkedOrderIds || []).filter(Boolean);
  const or = [{ sowingDoneRequestId: rid }];
  if (linked.length) or.push({ _id: { $in: linked } });
  const result = await Order.updateMany(
    { $or: or },
    {
      $set: { sowingDone: false, leftoverFromIncomplete: false },
      $unset: { sowingDoneAt: 1, sowingDoneRequestId: 1 },
      $pull: { sowingPartialCover: { requestId: rid } },
    }
  );
  return { modifiedCount: Number(result.modifiedCount) || 0 };
}

import catchAsync from "../utility/catchAsync.js";
import generateResponse from "../utility/responseFormat.js";
import AppError from "../utility/appError.js";
import { findDispatchActiveByIdOrTransport } from "../services/secondaryVehicleLoad.service.js";
import { returnPlantsFromVehicle } from "../services/secondaryVehicleReturn.service.js";

/** POST plants from a loaded vehicle back into a shed (shed app). Stock only. */
export const postSecondaryVehicleReturn = catchAsync(async (req, res, next) => {
  const doc = await findDispatchActiveByIdOrTransport(req.params.dispatchId);
  if (!doc) return next(new AppError("Vehicle dispatch not found", 404));

  const { batchId, sourceOutwardId, orderId, pollyhouse, quantity, reason } = req.body ?? {};
  const data = await returnPlantsFromVehicle({
    dispatchId: doc._id,
    batchId,
    sourceOutwardId,
    orderId,
    pollyhouse,
    quantity,
    reason,
    source: "APP",
    performedBy: req.user?._id || req.user?.id,
  });
  return res
    .status(200)
    .json(generateResponse("Success", `${data.quantity} plants returned to shed`, data, undefined));
});

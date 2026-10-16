import catchAsync from "../utility/catchAsync.js";
import generateResponse from "../utility/responseFormat.js";
import { destroySowBatchPlants } from "../services/sowBatchDestroy.service.js";

/** POST /sowing/sow-batch/destroy — { slotId, batchId | sowingRequestId, quantity, reason } (ERP + shed app). */
export const postDestroySowBatch = catchAsync(async (req, res) => {
  const { slotId, batchId, sowingRequestId, quantity, reason } = req.body ?? {};
  const data = await destroySowBatchPlants({
    slotId,
    batchId,
    sowingRequestId,
    quantity,
    reason,
    performedBy: req.user?._id || req.user?.id,
  });
  return res
    .status(200)
    .json(generateResponse("Success", `${data.destroyed} sown plants destroyed`, data, undefined));
});

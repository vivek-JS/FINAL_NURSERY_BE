import catchAsync from "../utility/catchAsync.js";
import generateResponse from "../utility/responseFormat.js";
import { destroySecondaryInwardPlants } from "../services/secondaryInwardDestroy.service.js";

/** POST destroyed plants on one secondary lagwad line (shed app + ERP). */
export const postSecondaryInwardDestroy = catchAsync(async (req, res) => {
  const { batchId, secondaryInwardId } = req.params;
  const { quantity, reason } = req.body ?? {};
  const data = await destroySecondaryInwardPlants({
    batchId,
    secondaryInwardId,
    quantity,
    reason,
    performedBy: req.user?._id || req.user?.id,
  });
  return res
    .status(200)
    .json(generateResponse("Success", `${data.destroyed} plants marked destroyed`, data, undefined));
});

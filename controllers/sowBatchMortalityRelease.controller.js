import catchAsync from "../utility/catchAsync.js";
import AppError from "../utility/appError.js";
import { isSuperAdminUser } from "../services/sowBatchIrrelevant.service.js";
import { releaseBatchMortalityToExcess } from "../services/sowBatchMortalityRelease.service.js";

/** POST /sowing/sow-batch/mortality-to-excess — { slotId, batchId } (super admin). */
export const postReleaseBatchMortality = catchAsync(async (req, res) => {
  if (!isSuperAdminUser(req.user)) {
    throw new AppError("Only a super admin can move mortality into excess", 403);
  }
  const { slotId, batchId } = req.body ?? {};
  const data = await releaseBatchMortalityToExcess({
    slotId,
    batchId,
    performedBy: req.user?._id || req.user?.id,
  });
  return res.status(200).json({
    success: true,
    message: "Mortality moved to excess",
    ...data,
  });
});

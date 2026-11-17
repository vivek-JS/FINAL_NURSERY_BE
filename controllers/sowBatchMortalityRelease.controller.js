import catchAsync from "../utility/catchAsync.js";
import AppError from "../utility/appError.js";
import { isSuperAdminUser } from "../services/sowBatchIrrelevant.service.js";
import {
  releaseBatchMortalityToExcess,
  moveBatchExcessToMortality,
} from "../services/sowBatchMortalityRelease.service.js";

/** POST /sowing/sow-batch/mortality-to-excess — { slotId, batchId, plants } (super admin). */
export const postReleaseBatchMortality = catchAsync(async (req, res) => {
  if (!isSuperAdminUser(req.user)) {
    throw new AppError("Only a super admin can move mortality into excess", 403);
  }
  const { slotId, batchId, plants } = req.body ?? {};
  const data = await releaseBatchMortalityToExcess({
    slotId,
    batchId,
    plants,
    performedBy: req.user?._id || req.user?.id,
  });
  return res.status(200).json({
    success: true,
    message: "Mortality moved to excess",
    ...data,
  });
});

/** POST /sowing/sow-batch/excess-to-mortality — { slotId, batchId, plants } (super admin). */
export const postMoveExcessToMortality = catchAsync(async (req, res) => {
  if (!isSuperAdminUser(req.user)) {
    throw new AppError("Only a super admin can move excess into mortality", 403);
  }
  const { slotId, batchId, plants } = req.body ?? {};
  const data = await moveBatchExcessToMortality({
    slotId,
    batchId,
    plants,
    performedBy: req.user?._id || req.user?.id,
  });
  return res.status(200).json({
    success: true,
    message: "Excess moved to mortality",
    ...data,
  });
});

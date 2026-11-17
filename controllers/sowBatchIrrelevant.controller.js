import catchAsync from "../utility/catchAsync.js";
import AppError from "../utility/appError.js";
import { isSuperAdminUser, setSowBatchIrrelevant } from "../services/sowBatchIrrelevant.service.js";

/** POST /sowing/sow-batch/irrelevant — { slotId, batchId, isIrrelevant } (super admin). */
export const postSowBatchIrrelevant = catchAsync(async (req, res) => {
  if (!isSuperAdminUser(req.user)) {
    throw new AppError("Only a super admin can mark a sowing batch irrelevant", 403);
  }
  const { slotId, batchId, isIrrelevant } = req.body ?? {};
  const data = await setSowBatchIrrelevant({
    slotId,
    batchId,
    isIrrelevant,
    performedBy: req.user?._id || req.user?.id,
  });
  const message = data.isIrrelevant
    ? "Sowing batch marked irrelevant"
    : "Sowing batch marked relevant";
  return res.status(200).json({ success: true, message, ...data });
});

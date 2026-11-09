import catchAsync from "../utility/catchAsync.js";
import generateResponse from "../utility/responseFormat.js";
import {
  assertDispatchVisible,
  assignVehicleDispatch,
  listDispatchAssignees,
} from "../services/dispatchAssignment.service.js";

export const getDispatchAssignees = catchAsync(async (req, res) => {
  const items = await listDispatchAssignees(req.user);
  res.status(200).json(generateResponse("Success", "Dispatch employees", items, undefined));
});

export const postAssignVehicleDispatch = catchAsync(async (req, res) => {
  const data = await assignVehicleDispatch({
    dispatchId: req.params.dispatchId,
    userId: req.body?.userId,
    actor: req.user,
  });
  res.status(200).json(generateResponse("Success", "Vehicle assigned", data, undefined));
});

/** Blocks a dispatch employee from opening a vehicle that is not assigned to them. */
export function requireOwnAssignedDispatch(req, res, next) {
  assertDispatchVisible(req.user, req.params.dispatchId)
    .then(() => next())
    .catch(next);
}

import EmployeeOfficeGroup from "../models/employeeOfficeGroup.model.js";
import catchAsync from "../utility/catchAsync.js";
import generateResponse from "../utility/responseFormat.js";
import AppError from "../utility/appError.js";

/** GET /api/v1/admin/attendance/office-groups */
export const listOfficeGroups = catchAsync(async (req, res) => {
  const groups = await EmployeeOfficeGroup.find({ isActive: { $ne: false } })
    .sort({ name: 1 })
    .lean();
  return res.status(200).json(generateResponse("Success", "Office groups fetched", groups));
});

/** POST /api/v1/admin/attendance/office-groups */
export const createOfficeGroup = catchAsync(async (req, res, next) => {
  const { name, code, officeStartTime, officeEndTime, lateGraceMinutes, weeklyOffDays, branch_id, description } =
    req.body;
  if (!name || !code) return next(new AppError("name and code are required", 400));

  const existing = await EmployeeOfficeGroup.findOne({ code: String(code).toUpperCase() });
  if (existing) return next(new AppError("Office group code already exists", 409));

  const group = await EmployeeOfficeGroup.create({
    name,
    code: String(code).toUpperCase(),
    officeStartTime: officeStartTime || "09:30",
    officeEndTime: officeEndTime || "18:00",
    lateGraceMinutes: lateGraceMinutes ?? 10,
    weeklyOffDays: weeklyOffDays || [],
    branch_id: branch_id || null,
    description: description || null,
  });

  return res.status(201).json(generateResponse("Success", "Office group created", group));
});

/** PATCH /api/v1/admin/attendance/office-groups/:id */
export const patchOfficeGroup = catchAsync(async (req, res, next) => {
  const group = await EmployeeOfficeGroup.findById(req.params.id);
  if (!group) return next(new AppError("Office group not found", 404));

  const fields = [
    "name",
    "officeStartTime",
    "officeEndTime",
    "lateGraceMinutes",
    "weeklyOffDays",
    "branch_id",
    "description",
    "isActive",
  ];
  for (const f of fields) {
    if (req.body[f] !== undefined) group[f] = req.body[f];
  }
  await group.save();
  return res.status(200).json(generateResponse("Success", "Office group updated", group));
});

/** DELETE /api/v1/admin/attendance/office-groups/:id */
export const deleteOfficeGroup = catchAsync(async (req, res, next) => {
  const group = await EmployeeOfficeGroup.findById(req.params.id);
  if (!group) return next(new AppError("Office group not found", 404));
  group.isActive = false;
  await group.save();
  return res.status(200).json(generateResponse("Success", "Office group deactivated", null));
});

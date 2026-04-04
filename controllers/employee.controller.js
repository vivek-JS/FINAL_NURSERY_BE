import mongoose from "mongoose";
import Employee from "../models/user.model.js"; //not employee its user
import { deleteOne, getOne } from "./factory.controller.js";
import catchAsync from "../utility/catchAsync.js";
import AppError from "../utility/appError.js";
import generateResponse from "../utility/responseFormat.js";
import { createChangeLog, generateChangesArray } from "../utils/changeLogHelper.js";

const EMPLOYEE_PATCH_FIELDS = ["name", "phoneNumber", "jobTitle", "birthDate"];

const createEmployee = catchAsync(async (req, res, next) => {
  const doc = await Employee.create(req.body);
  const safe = doc.toObject();
  if (safe.password) delete safe.password;

  if (req.user?._id) {
    await createChangeLog({
      entityType: "employee",
      entityId: doc._id,
      action: "create",
      changedBy: req.user._id,
      changes: [
        { field: "name", oldValue: null, newValue: doc.name },
        { field: "phoneNumber", oldValue: null, newValue: doc.phoneNumber },
        { field: "jobTitle", oldValue: null, newValue: doc.jobTitle },
      ],
      description: `Employee "${doc.name}" created`,
      ipAddress: req.ip,
      userAgent: req.get("user-agent"),
    });
  }

  return res
    .status(201)
    .json(
      generateResponse("Success", "Employee created successfully", safe, undefined)
    );
});

const updateEmployee = catchAsync(async (req, res, next) => {
  let { id, _id, ...rest } = req.body;
  if (_id && !id) id = _id;

  if (!mongoose.isValidObjectId(id)) {
    return next(new AppError("Invalid ID format", 400));
  }

  const before = await Employee.findById(id).lean();
  if (!before) {
    return next(new AppError("No document found with that ID", 404));
  }

  const updates = {};
  for (const k of EMPLOYEE_PATCH_FIELDS) {
    if (rest[k] !== undefined) updates[k] = rest[k];
  }
  if (updates.phoneNumber !== undefined) {
    updates.phoneNumber = Number(updates.phoneNumber);
  }

  if (Object.keys(updates).length === 0) {
    return next(new AppError("No valid fields to update", 400));
  }

  const doc = await Employee.findByIdAndUpdate(id, updates, {
    new: true,
    runValidators: true,
  }).select("-password -__v");

  if (!doc) {
    return next(new AppError("No document found with that ID", 404));
  }

  const beforePick = {};
  const afterPick = {};
  for (const k of EMPLOYEE_PATCH_FIELDS) {
    beforePick[k] = before[k];
    afterPick[k] = doc[k];
  }
  const changes = generateChangesArray(beforePick, afterPick, EMPLOYEE_PATCH_FIELDS);
  if (changes.length > 0 && req.user?._id) {
    await createChangeLog({
      entityType: "employee",
      entityId: doc._id,
      action: "update",
      changedBy: req.user._id,
      changes,
      description: `Employee "${doc.name}" updated`,
      ipAddress: req.ip,
      userAgent: req.get("user-agent"),
    });
  }

  return res
    .status(200)
    .json(generateResponse("Success", "Employee updated successfully", doc));
});

const deleteEmployee = deleteOne(Employee, "Employee");
const getEmployee = getOne(Employee, "Employee");

const getEmployees = catchAsync(async (req, res) => {
  const { search = "", jobTitle, page = 1, limit = 500 } = req.query;
  const pageNum = Math.max(1, Number(page) || 1);
  const limitNum = Math.min(5000, Math.max(1, Number(limit) || 500));
  const skip = (pageNum - 1) * limitNum;
  const filter = {
    jobTitle: { $exists: true, $ne: null },
    role: { $ne: "FARMER" },
  };

  if (jobTitle) {
    filter.jobTitle = String(jobTitle).trim();
  }
  if (search) {
    const searchRegex = new RegExp(String(search).trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    filter.$or = [{ name: searchRegex }, { jobTitle: searchRegex }];
    if (/^\d+$/.test(String(search).trim())) {
      filter.$or.push({ phoneNumber: Number(search) });
    }
  }

  const docs = await Employee.find(filter)
    .select("-password -__v")
    .sort({ createdAt: -1 })
    .skip(skip)
    .limit(limitNum)
    .lean();

  const transformed = docs.map((item) => ({ id: item._id, ...item }));
  return res
    .status(200)
    .json(generateResponse("Success", "Employee found successfully", transformed, undefined));
});

export {
  createEmployee,
  updateEmployee,
  deleteEmployee,
  getEmployees,
  getEmployee,
};

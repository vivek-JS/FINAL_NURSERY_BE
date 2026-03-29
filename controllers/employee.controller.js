import Employee from "../models/user.model.js"; //not employee its user
import {
  createOne,
  updateOne,
  deleteOne,
  getOne,
} from "./factory.controller.js";
import catchAsync from "../utility/catchAsync.js";
import generateResponse from "../utility/responseFormat.js";

const createEmployee = createOne(Employee, "Employee");
const updateEmployee = updateOne(Employee, "Employee");
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

import Farmer from "../models/farmer.model.js";
import AppError from "../utility/appError.js";
import catchAsync from "../utility/catchAsync.js";
import { updateOne, deleteOne } from "./factory.controller.js";

const updateFarmer = updateOne(Farmer, "Farmer");
const deleteFarmer = deleteOne(Farmer, "Farmer");

const findFarmer = catchAsync(async (req, res, next) => {
  const {mobileNumber } = req.params;
  const farmer = await Farmer.findOne({ mobileNumber });

  if (farmer) {
    // Return the farmer record if found
    return res.status(200).json({
      status: "success",
      message: "Farmer record found",
      data: farmer,
    });
  }

  // Return a "No record found" message if no farmer is found
  return res.status(404).json({
    status: "fail",
    message: "No record found for the given mobile number",
  });
});

const createFarmer = catchAsync(async (req, res, next) => {
  let farmer = await Farmer.findOne({ mobileNumber: req.body.mobileNumber });

  if (!farmer) {
    farmer = await new Farmer(req.body).save();
  }

  req.body.farmer = farmer._id;
  next();
});

export { createFarmer, updateFarmer, deleteFarmer, findFarmer };

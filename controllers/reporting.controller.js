import ReportedFarmer from "../models/reporting.model.js";
import {
  createOne,
  updateOne,
  deleteOne,
  getOne,
  getAll,
} from "../controllers/factory.controller.js";

const getReporting = getOne(ReportedFarmer, "ReportedFarmer");
const getAllReportings = getAll(ReportedFarmer, "ReportedFarmer");
const createReporting = createOne(ReportedFarmer, "ReportedFarmer");
const updateReporting = updateOne(ReportedFarmer, "ReportedFarmer");
const deleteReporting = deleteOne(ReportedFarmer, "ReportedFarmer");

export {
  createReporting,
  updateReporting,
  deleteReporting,
  getReporting,
  getAllReportings,
};

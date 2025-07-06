import express from "express";
import { check } from "express-validator";
import checkErrors from "../middlewares/checkErrors.middleware.js";
import {
  createReporting,
  updateReporting,
  deleteReporting,
  getAllReportings,
  getReporting,
} from "../controllers/reporting.controller.js";
import { createFarmer } from "../controllers/farmer.controller.js";

const router = express.Router();

router
  .get("/:id", getReporting)
  .get("/", getAllReportings)
  .post(
    "/createReporting",
    [
      check("name").notEmpty().withMessage("Name of farmer is required"),
      check("village")
        .notEmpty()
        .withMessage("Village name of farmer is required"),
      check("taluka")
        .notEmpty()
        .withMessage("Taluka name of farmer is required"),
      check("district")
        .notEmpty()
        .withMessage("District name of farmer is required"),
      check("mobileNumber")
        .isNumeric()
        .withMessage("Mobile number of farmer is required"),
      check("nameOfPlant").notEmpty().withMessage("Name of plant is required"),
      check("totalPlants")
        .isNumeric()
        .withMessage("Total plant planted is required"),
      check("timeOfPlantation")
        .isDate()
        .withMessage("Time of plantation of plant is required"),
      check("reportedBy").isMongoId().withMessage("Reported by  is required"),
    ],
    checkErrors,
    createFarmer,
    createReporting
  )
  .patch(
    "/updateReporting",
    [check("id").notEmpty().withMessage("Reporting Id is required")],
    checkErrors,
    updateReporting
  )
  .delete(
    "/deleteReporting",
    [check("id").notEmpty().withMessage("Reporting Id is required")],
    checkErrors,
    deleteReporting
  );

export default router;

import express from "express";
import { check } from "express-validator";
import checkErrors from "../middlewares/checkErrors.middleware.js";
import {
  createSecondaryHardening,
  updateSecondaryHardening,
  deleteSecondaryHardening,
  getSecondaryHardening,
  getAllSecondaryHardening,
} from "../controllers/secondaryHardening.controller.js";

const router = express.Router();

router
  .get("/getSecondaryHardening/:id", getSecondaryHardening)
  .get("/getSecondaryHardening", getAllSecondaryHardening)
  .post(
    "/createSecondaryHardening",
    [
      check("initialData.batchNumber")
        .notEmpty()
        .withMessage("Batch number is required"),
      check("initialData.date").isDate().withMessage("Date is required"),
      check("initialData.numberOfBottleReceived")
        .isNumeric()
        .withMessage("Number of bottles received is required"),
    ],
    checkErrors,
    createSecondaryHardening
  )
  .patch(
    "/updateSecondaryHardening/plantation",
    [
      check("plantation.usedBottles")
        .notEmpty()
        .withMessage("Used bottles is required"),
      check("plantation.batchNumber")
        .notEmpty()
        .withMessage("Batch number is required"),
      check("plantation.numberOfPlants")
        .notEmpty()
        .withMessage("Number of plants required"),

      check("plantation.numberOfTrays")
        .notEmpty()
        .withMessage("Number of trays is required"),
    ],
    checkErrors,
    updateSecondaryHardening
  )
  .patch(
    "/updateSecondaryHardening/dispatch",
    [
      check("dispatch.date")
        .notEmpty()
        .withMessage("Dispatch dates is required"),
      check("dispatch.batchNumber")
        .notEmpty()
        .withMessage("Batch number is required"),
      check("dispatch.numberOfTraysDispatched")
        .notEmpty()
        .withMessage("Number of trays dispatched required"),
      check("dispatch.shadeNumber")
        .notEmpty()
        .withMessage("Shade number is required"),
    ],
    checkErrors,
    updateSecondaryHardening
  )
  .delete(
    "/deleteSecondaryHardening/dispatch",
    [
      check("dispatch.date")
        .notEmpty()
        .withMessage("Dispatch dates is required"),
      check("dispatch.batchNumber")
        .notEmpty()
        .withMessage("Batch number is required"),
      check("dispatch.numberOfTraysDispatched")
        .notEmpty()
        .withMessage("Number of trays dispatched required"),
      check("dispatch.shadeNumber")
        .notEmpty()
        .withMessage("Shade number is required"),
    ],
    checkErrors,
    deleteSecondaryHardening
  );

export default router;

import express from "express";
import { check } from "express-validator";
import checkErrors from "../middlewares/checkErrors.middleware.js";
import {
  createPrimaryHardening,
  updatePrimaryHardening,
  deletePrimaryHardening,
  getPrimaryHardening,
  getAllPrimaryHardening,
} from "../controllers/primaryHardening.controller.js";

const router = express.Router();

router
  .get("/getPrimaryHardening/:id", getPrimaryHardening)
  .get("/getPrimaryHardening", getAllPrimaryHardening)
  .post(
    "/createPrimaryHardening",
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
    createPrimaryHardening
  )
  .patch(
    "/updatePrimaryHardening/plantation",
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
    updatePrimaryHardening
  )
  .patch(
    "/updatePrimaryHardening/dispatch",
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
    updatePrimaryHardening
  )
  .delete("/deletePrimaryHardening", deletePrimaryHardening);

export default router;

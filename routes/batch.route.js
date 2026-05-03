import express from "express";
import { check } from "express-validator";
import mongoose from "mongoose";
import checkErrors from "../middlewares/checkErrors.middleware.js";
import {
  createBatch,
  getAllBatches,
  updateBatch,
  toggleBatchStatus,
} from "../controllers/batch.controller.js";

const router = express.Router();

const validateObjectId = (value) => {
  if (!mongoose.Types.ObjectId.isValid(value)) {
    throw new Error("Invalid ID format");
  }
  return true;
};

router
  .post(
    "/create",
    [
      check("batchNumber").trim().notEmpty().withMessage("Batch number is required"),
      check("dateAdded")
        .optional()
        .isISO8601()
        .withMessage("Invalid date format"),
      check("primaryPlantReadyDays")
        .exists()
        .withMessage("Primary plant ready days are required")
        .bail()
        .isInt({ min: 1 })
        .withMessage("Primary plant ready days must be a positive integer")
        .toInt(),
      check("secondaryPlantReadyDays")
        .exists()
        .withMessage("Secondary plant ready days are required")
        .bail()
        .isInt({ min: 1 })
        .withMessage("Secondary plant ready days must be a positive integer")
        .toInt(),
      check("plantCmsId")
        .exists()
        .withMessage("Plant is required")
        .bail()
        .custom(validateObjectId),
      check("plantSubtypeId")
        .exists()
        .withMessage("Plant subtype is required")
        .bail()
        .custom(validateObjectId),
    ],
    checkErrors,
    createBatch
  )
  .get("/all", getAllBatches)
  .patch(
    "/update",
    [
      check("id")
        .exists()
        .withMessage("ID is required")
        .custom(validateObjectId),
      check("batchNumber")
        .optional()
        .trim()
        .notEmpty()
        .withMessage("Batch number cannot be empty"),
      check("dateAdded")
        .optional()
        .isISO8601()
        .withMessage("Invalid date format"),
      check("primaryPlantReadyDays")
        .optional()
        .isInt({ min: 1 })
        .withMessage("Primary plant ready days must be a positive integer")
        .toInt(),
      check("secondaryPlantReadyDays")
        .optional()
        .isInt({ min: 1 })
        .withMessage("Secondary plant ready days must be a positive integer")
        .toInt(),
    ],
    checkErrors,
    updateBatch
  )
  .patch(
    "/toggle-status",
    [
      check("id")
        .exists()
        .withMessage("ID is required")
        .custom(validateObjectId),
      check("isActive")
        .isBoolean()
        .withMessage("isActive must be a boolean value")
        .toBoolean(),
    ],
    checkErrors,
    toggleBatchStatus
  );

export default router;

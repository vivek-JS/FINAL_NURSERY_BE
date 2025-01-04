import express from "express";
import { check } from "express-validator";
import mongoose from "mongoose";
import checkErrors from "../middlewares/checkErrors.middleware.js";
import {
 createBatch,
 getAllBatches,
 updateBatch,
 toggleBatchStatus
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
     check("batchNumber").notEmpty().withMessage("Batch number is required"),
     check("dateAdded")
       .optional()
       .isISO8601().withMessage("Invalid date format")
   ],
   checkErrors,
   createBatch
 )
 .get("/all", getAllBatches)
 .patch(
   "/update",
   [
     check("id")
       .exists().withMessage("ID is required")
       .custom(validateObjectId),
     check("batchNumber")
       .optional()
       .notEmpty().withMessage("Batch number cannot be empty"),
     check("dateAdded")
       .optional()
       .isISO8601().withMessage("Invalid date format")
   ],
   checkErrors,
   updateBatch
 )
 .patch(
   "/toggle-status",
   [
     check("id")
       .exists().withMessage("ID is required")
       .custom(validateObjectId),
     check("isActive")
       .isBoolean().withMessage("isActive must be a boolean value")
   ],
   checkErrors,
   toggleBatchStatus
 );

export default router;
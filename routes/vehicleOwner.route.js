import express from "express";
import { check } from "express-validator";
import checkErrors from "../middlewares/checkErrors.middleware.js";
import mongoose from "mongoose";
import {
  createVehicleOwner,
  getAllVehicleOwners,
  getActiveVehicleOwners,
  getVehicleOwnerById,
  updateVehicleOwner,
  deleteVehicleOwner,
} from "../controllers/vehicleOwner.controller.js";

const router = express.Router();

router
  .post(
    "/create",
    [check("name").notEmpty().withMessage("Owner name is required")],
    checkErrors,
    createVehicleOwner
  )
  .get("/all", getAllVehicleOwners)
  .get("/active", getActiveVehicleOwners)
  .get(
    "/:id",
    [
      check("id")
        .isMongoId()
        .withMessage("Invalid owner id format"),
    ],
    checkErrors,
    getVehicleOwnerById
  )
  .patch(
    "/update",
    [
      check("id")
        .exists()
        .withMessage("ID is required")
        .custom((value) => {
          if (!mongoose.isValidObjectId(value)) {
            throw new Error("Invalid ID format");
          }
          return true;
        }),
      check("name")
        .optional()
        .notEmpty()
        .withMessage("Owner name cannot be empty"),
    ],
    checkErrors,
    updateVehicleOwner
  )
  .delete(
    "/delete",
    [
      check("id")
        .exists()
        .withMessage("ID is required")
        .custom((value) => {
          if (!mongoose.isValidObjectId(value)) {
            throw new Error("Invalid ID format");
          }
          return true;
        }),
    ],
    checkErrors,
    deleteVehicleOwner
  );

export default router;

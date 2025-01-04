import express from "express";
import { check } from "express-validator";
import mongoose from "mongoose";
import checkErrors from "../middlewares/checkErrors.middleware.js";
import {
  createTray,
  getAllTrays,
  updateTray,
  toggleTrayStatus,
} from "../controllers/tray.controller.js";

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
      check("name").notEmpty().withMessage("Tray name is required"),
      check("cavity")
        .notEmpty()
        .withMessage("Cavity is required")
        .isNumeric()
        .withMessage("Cavity must be a number")
        .isInt({ min: 1 })
        .withMessage("Cavity must be at least 1"),
    ],
    checkErrors,
    createTray
  )
  .get("/all", getAllTrays)
  .patch(
    "/update",
    [
      check("id")
        .exists()
        .withMessage("ID is required")
        .custom(validateObjectId),
      check("name").optional().notEmpty().withMessage("Name cannot be empty"),
      check("cavity")
        .optional()
        .isNumeric()
        .withMessage("Cavity must be a number")
        .isInt({ min: 1 })
        .withMessage("Cavity must be at least 1"),
    ],
    checkErrors,
    updateTray
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
        .withMessage("isActive must be a boolean value"),
    ],
    checkErrors,
    toggleTrayStatus
  );

export default router;

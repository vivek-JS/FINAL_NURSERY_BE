import express from "express";
import { check } from "express-validator";
import checkErrors from "../middlewares/checkErrors.middleware.js";
import {
  createShade,
  getAllShades,
  updateShade,
  toggleShadeStatus
} from "../controllers/shades.controller.js";
import mongoose from "mongoose";

const router = express.Router();

router
  .post(
    "/create",
    [
      check("name").notEmpty().withMessage("Shade name is required"),
      check("number")
        .notEmpty()
        .withMessage("Shade number is required")
    ],
    checkErrors,
    createShade
  )
  .get("/all", getAllShades)
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
        })
    ],
    checkErrors,
    updateShade
  )
  .patch(
    "/toggle-status",
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
      check("isActive")
        .isBoolean()
        .withMessage("isActive must be a boolean value")
    ],
    checkErrors,
    toggleShadeStatus
  );

export default router;
import {
  createFarmer,
  updateFarmer,
  deleteFarmer,
  findFarmer,
} from "../controllers/farmer.controller.js";
import { createOrder } from "../controllers/order.controller.js";
import express from "express";
import { check } from "express-validator";
import checkErrors from "../middlewares/checkErrors.middleware.js";
import {
  createVillage,
  createTaluka,
  createDistrict,
} from "../controllers/cms.controller.js";
import { upload } from "../middlewares/multer.middleware.js";

const router = express.Router();

router
  .post(
    "/createFarmer",
    upload.single("receiptPhoto"),
    [
      check("name").notEmpty().withMessage("Please enter valid name"),
      check("village").notEmpty().withMessage("Please enter valid village"),
      check("taluka").notEmpty().withMessage("Please enter valid taluka"),
      check("district").notEmpty().withMessage("Please enter valid district"),
      check("mobileNumber")
        .notEmpty()
        .withMessage("Please enter valid mobile number"),
    ],
    checkErrors,
    createVillage,
    createTaluka,
    createDistrict,
    createFarmer,
    [
      check("salesPerson")
        .isMongoId()
        .withMessage("Please provide id of sales person"),
      check("typeOfPlants")
        .notEmpty()
        .withMessage("Please provide type of plants"),
      check("numberOfPlants")
        .notEmpty()
        .withMessage("Please provide number of plants"),
      check("rate").notEmpty().withMessage("Please provide rate"),
      check("paymentStatus")
        .notEmpty()
        .withMessage("Please provide payment status"),
    ],
    checkErrors,
    createOrder
  )
  .patch(
    "/updateFarmer",
    [check("id").isMongoId().withMessage("Please enter valid farmerId")],
    checkErrors,
    updateFarmer
  )
  .delete(
    "/deleteFarmer",
    [check("id").isMongoId().withMessage("Please enter valid farmerId")],
    checkErrors,
    deleteFarmer
  );

export default router;

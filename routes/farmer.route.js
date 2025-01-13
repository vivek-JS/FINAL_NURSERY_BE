import {
  createFarmer,
  updateFarmer,
  deleteFarmer,
  findFarmer,
  getFarmers,
  uploadFarmers,
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
import multer from "multer";
// import { upload } from "../middlewares/multer.middleware.js";

const router = express.Router();

// Configure multer for file upload
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, "./public/uploads/");
  },
  filename: function (req, file, cb) {
    cb(null, Date.now() + "-" + file.originalname);
  },
});

const upload = multer({
  storage: storage,
  fileFilter: function (req, file, cb) {
    // Accept only excel files
    if (
      file.mimetype ===
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
      file.mimetype === "application/vnd.ms-excel"
    ) {
      cb(null, true);
    } else {
      cb(new Error("Only Excel files are allowed!"));
    }
  },
});

router
  .get("/getfarmer/:mobileNumber", findFarmer)
  .get("/getFarmers", getFarmers)
  .post("/uploadFarmers", upload.single("data"), uploadFarmers)
  .post(
    "/createFarmer",
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

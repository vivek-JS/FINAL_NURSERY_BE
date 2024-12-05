import express from "express";
import {
  getCsv,
  updateOrder,
  addNewPayment,
  getOrders,
  updatePaymentStatus,
} from "../controllers/order.controller.js";
import { check } from "express-validator";
import checkErrors from "../middlewares/checkErrors.middleware.js";
import { upload } from "../middlewares/multer.middleware.js";

const router = express.Router();

router
  .get("/getCSV", getCsv)
  .get("/getOrders", getOrders)
  .patch(
    "/updatePaymentStatus",
    updatePaymentStatus
  )
  .patch(
    "/payment/:orderId",
    addNewPayment // Controller function to add payment
  )
  .patch(
    "/updateOrder",
    [check("id").isMongoId().withMessage("Please provide order id")],
    checkErrors,
    updateOrder
  );

export default router;

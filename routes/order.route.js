import express from "express";
import {
  getCsv,
  updateOrder,
  addNewPayment,
  getOrders,
  updatePaymentStatus,
  getOrdersBySlot,
  createDealerOrder,
  addAfterDispatchedOrderIds,
  getOrdersByStatus,
  getAllPayments,
  getUniqueVillages,
  getUniqueDistricts,
  getDealerWalletBalanceForOrder
} from "../controllers/order.controller.js";
import { check } from "express-validator";
import checkErrors from "../middlewares/checkErrors.middleware.js";
import { upload } from "../middlewares/multer.middleware.js";
import { requirePaymentAccess, requirePaymentAddAccess } from "../middlewares/auth.middleware.js";

const router = express.Router();

router
  .get("/getCSV", getCsv)
  .get("/slots", getOrdersBySlot)
  .get("/getOrders", getOrders)
  .get("/by-status", getOrdersByStatus)
  .get("/payments", getAllPayments)
  .get("/villages", getUniqueVillages)
  .get("/districts", getUniqueDistricts)
  .get("/dealer-wallet/:orderId", getDealerWalletBalanceForOrder)
  .patch("/updatePaymentStatus", requirePaymentAccess, updatePaymentStatus)
  .patch(
    "/payment/:orderId",
    requirePaymentAddAccess,
    addNewPayment // Controller function to add payment
  )
  .patch(
    "/updateOrder",
    [check("id").isMongoId().withMessage("Please provide order id")],
    checkErrors,
    updateOrder
  )
  .post("/dealer-order", createDealerOrder)
  .patch("/afterOrder",addAfterDispatchedOrderIds)

export default router;

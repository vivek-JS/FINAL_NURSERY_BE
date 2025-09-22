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
  getDealerWalletBalanceForOrder,
  getOrdersToBeDispatched
} from "../controllers/order.controller.js";
import { check } from "express-validator";
import checkErrors from "../middlewares/checkErrors.middleware.js";
import { upload } from "../middlewares/multer.middleware.js";
import { requirePaymentAccess } from "../middlewares/auth.middleware.js";

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
  .get("/to-be-dispatched", getOrdersToBeDispatched)
  .patch("/updatePaymentStatus", requirePaymentAccess, updatePaymentStatus)
  .patch(
    "/payment/:orderId",
    addNewPayment // Controller function to add payment - anyone can add
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

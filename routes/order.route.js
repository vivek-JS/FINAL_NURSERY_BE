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
import {
  getOrderDispatchDetails,
  getOrdersByDispatch,
  getDispatchSummary
} from "../controllers/orderDispatchDetails.controller.js";
import { check } from "express-validator";
import checkErrors from "../middlewares/checkErrors.middleware.js";
import { upload } from "../middlewares/multer.middleware.js";
import { requirePaymentAccess, authenticateToken } from "../middlewares/auth.middleware.js";
import { sendPaymentCollectedNotification } from "../utility/pushNotification.js";
import catchAsync from "../utility/catchAsync.js";

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
  .get("/dispatch-details/:orderId", getOrderDispatchDetails)
  .get("/by-dispatch/:transportId", getOrdersByDispatch)
  .get("/dispatch-summary", getDispatchSummary)
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
  .post("/test-notification", authenticateToken, catchAsync(async (req, res) => {
    // Test endpoint to send a notification to current user
    const User = (await import("../models/user.model.js")).default;
    const user = await User.findById(req.user._id);
    
    if (!user.expoPushToken) {
      return res.status(400).json({
        success: false,
        message: "You don't have a push token. Open the mobile app first to register."
      });
    }

    const result = await sendPaymentCollectedNotification(
      user.expoPushToken,
      "TEST-123",
      5000
    );

    res.json({
      success: true,
      message: "Test notification sent!",
      result,
      userInfo: {
        name: user.name,
        phone: user.phoneNumber,
        hasPushToken: !!user.expoPushToken
      }
    });
  }))
  .post("/dealer-order", createDealerOrder)
  .patch("/afterOrder",addAfterDispatchedOrderIds)

export default router;

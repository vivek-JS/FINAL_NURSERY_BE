import express from "express";
import {
  getCsv,
  updateOrder,
  addNewPayment,
  addBatchPayments,
  getOrders,
  updatePaymentStatus,
  getOrdersBySlot,
  createDealerOrder,
  addAfterDispatchedOrderIds,
  getOrdersByStatus,
  getAllPayments,
  getUniqueVillages,
  getUniqueDistricts,
  getUniqueTalukas,
  getDealerWalletBalanceForOrder,
  getOrdersToBeDispatched,
  getAllCavitiesFromOrders,
  getOrderBucketing,
  getSalesmenBucketing,
  createPaymentActivity,
  getPaymentActivities,
  getTodaysPaymentActivities,
  getUnclearedPayments,
  getPaymentsForApproval,
  reconcilePayments,
  generatePaymentQR,
  sendOrderAcceptedWhatsAppController,
  sendOrderPlacedWhatsAppController,
  sendOrderDispatchWhatsAppController,
  sendOrderFarmReadyWhatsAppController,
  sendSelectedOrdersWhatsappController,
  listOrderWhatsappOutboundController,
  listOrderWhatsappCampaignsController,
  getDeliverySummary,
  getDeliveryOrders,
  splitOrder,
  getGeoSummary,
  getRemainingDispatchAggregate,
  getRemainingDispatchOrdersByCell,
  getRemainingDispatchMatrix,
  getRemainingDispatchMatrixOrders,
  getFarmerOrdersDashboardTabCounts,
  getAdminDashboardStats,
  getAdminDailyMis,
  getAdminSalesMis,
  getAdminDealerMis,
  getAdminDueMis,
} from "../controllers/order.controller.js";
import {
  getFarmerPlantOrderDetails,
  getOrderPaymentTransferContext,
  getFarmerPlantLedgerParties,
  transferFarmerPlantAdvance,
  transferFarmerPlantOrderPayment,
  createFarmerOrderTransferRequest,
  getFarmerOrderTransferRequests,
  approveFarmerOrderTransferRequest,
  rejectFarmerOrderTransferRequest,
  searchFarmersForLedgerTransfer,
  createManualFarmerPlantLedgerEntry,
} from "../controllers/farmerPlantOrderLedger.controller.js";
import {
  createBulkPayment,
  getBulkPayments,
  acceptBulkPayment
} from "../controllers/bulkPayment.controller.js";
import {
  getOrderDispatchDetails,
  getOrdersByDispatch,
  getDispatchSummary
} from "../controllers/orderDispatchDetails.controller.js";
import { check } from "express-validator";
import checkErrors from "../middlewares/checkErrors.middleware.js";
import multer from "multer";
import {
  requirePaymentAccess,
  requireBulkPaymentCreateAccess,
  authenticateToken,
  authorizeRoles,
} from "../middlewares/auth.middleware.js";
import { sendPaymentCollectedNotification } from "../utility/pushNotification.js";
import catchAsync from "../utility/catchAsync.js";
import { noCacheApiResponse } from "../middlewares/noCacheApi.middleware.js";
import { getPlantOrderTimeline } from "../modules/orderEvents/api/orderEvents.controller.js";

const router = express.Router();

// Multer for images (memory storage for Cloudinary)
const uploadImages = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 }, // 8MB
  fileFilter: (req, file, cb) => {
    const ok = ["image/jpeg", "image/png", "image/webp", "image/avif", "image/gif"].includes(file.mimetype);
    cb(ok ? null : new Error("Only JPG/PNG/WEBP/AVIF/GIF allowed"), ok);
  },
});

router
  .get("/farmer-plant/:orderId/details", getFarmerPlantOrderDetails)
  .get(
    "/farmer-plant-ledger/transfer-context",
    requirePaymentAccess,
    getOrderPaymentTransferContext
  )
  .get("/farmer-plant-ledger/parties", requirePaymentAccess, getFarmerPlantLedgerParties)
  .get("/farmer-plant-ledger/search-farmers", searchFarmersForLedgerTransfer)
  .post("/farmer-plant-ledger/transfer-advance", requirePaymentAccess, transferFarmerPlantAdvance)
  .post("/farmer-plant-ledger/transfer-order-payment", requirePaymentAccess, transferFarmerPlantOrderPayment)
  .post("/farmer-plant-ledger/transfer-requests", createFarmerOrderTransferRequest)
  .post("/dealer-plant-ledger/transfer-requests", createFarmerOrderTransferRequest)
  .get("/farmer-plant-ledger/transfer-requests", requirePaymentAccess, getFarmerOrderTransferRequests)
  .get("/dealer-plant-ledger/transfer-requests", requirePaymentAccess, getFarmerOrderTransferRequests)
  .patch("/farmer-plant-ledger/transfer-requests/:id/approve", requirePaymentAccess, approveFarmerOrderTransferRequest)
  .patch("/dealer-plant-ledger/transfer-requests/:id/approve", requirePaymentAccess, approveFarmerOrderTransferRequest)
  .patch("/farmer-plant-ledger/transfer-requests/:id/reject", requirePaymentAccess, rejectFarmerOrderTransferRequest)
  .patch("/dealer-plant-ledger/transfer-requests/:id/reject", requirePaymentAccess, rejectFarmerOrderTransferRequest)
  .post("/farmer-plant-ledger/manual-entry", requirePaymentAccess, createManualFarmerPlantLedgerEntry)
  .get("/getCSV", getCsv)
  .get("/slots", getOrdersBySlot)
  .get("/getOrders", getOrders)
  .get("/dashboard-tab-counts", getFarmerOrdersDashboardTabCounts)
  .get("/admin-dashboard-stats", getAdminDashboardStats)
  .get(
    "/admin-daily-mis",
    authorizeRoles(["ADMIN", "SUPER_ADMIN", "SUPERADMIN"]),
    getAdminDailyMis
  )
  .get(
    "/admin-mis-sales",
    authorizeRoles(["ADMIN", "SUPER_ADMIN", "SUPERADMIN"]),
    getAdminSalesMis
  )
  .get(
    "/admin-mis-dealer",
    authorizeRoles(["ADMIN", "SUPER_ADMIN", "SUPERADMIN"]),
    getAdminDealerMis
  )
  .get(
    "/admin-mis-due",
    authorizeRoles(["ADMIN", "SUPER_ADMIN", "SUPERADMIN"]),
    getAdminDueMis
  )
  .get("/by-status", getOrdersByStatus)
  .get("/payments", getAllPayments)
  .get("/bulk-payments", getBulkPayments)
  .post("/bulk-payment", requireBulkPaymentCreateAccess, createBulkPayment)
  .patch("/bulk-payment/:id/accept", requirePaymentAccess, acceptBulkPayment)
  .get("/villages", getUniqueVillages)
  .get("/districts", getUniqueDistricts)
  .get("/talukas", getUniqueTalukas)
  .get("/cavities", getAllCavitiesFromOrders)
  .get("/bucketing", getOrderBucketing)
  .get("/salesmen-bucketing", getSalesmenBucketing)
  .get("/dealer-wallet/:orderId", getDealerWalletBalanceForOrder)
  .get("/to-be-dispatched", getOrdersToBeDispatched)
  .get("/delivery-summary", getDeliverySummary)
  .get("/delivery-orders", getDeliveryOrders)
  .get("/remaining-dispatch-aggregate", getRemainingDispatchAggregate)
  .get("/remaining-dispatch-orders", getRemainingDispatchOrdersByCell)
  .get("/remaining-dispatch-matrix", getRemainingDispatchMatrix)
  .get("/remaining-dispatch-matrix-orders", getRemainingDispatchMatrixOrders)
  .get("/geo-summary", authenticateToken, getGeoSummary)
  .get("/dispatch-details/:orderId", getOrderDispatchDetails)
  .get("/by-dispatch/:transportId", getOrdersByDispatch)
  .get("/dispatch-summary", getDispatchSummary)
  .get("/payment-activity", authenticateToken, getPaymentActivities)
  .get("/payment-activity/today", authenticateToken, getTodaysPaymentActivities)
  .get("/payments/uncleared", requirePaymentAccess, getUnclearedPayments)
  .get("/payments/for-approval", requirePaymentAccess, getPaymentsForApproval)
  .post("/payments/reconcile", requirePaymentAccess, reconcilePayments)
  .post("/payment-activity", authenticateToken, createPaymentActivity)
  .patch("/updatePaymentStatus", requirePaymentAccess, updatePaymentStatus)
  .post("/:orderId/generate-payment-qr", generatePaymentQR)
  // Add payment: any authenticated user (router mounted with authenticateToken in app.js)
  .patch(
    "/payment/:orderId",
    uploadImages.single('screenshot'), // Handle single file upload for screenshot
    addNewPayment // Controller function to add payment
  )
  .post(
    "/payments/:orderId",
    uploadImages.single("screenshot"),
    addBatchPayments
  )
  .patch(
    "/updateOrder",
    [check("id").isMongoId().withMessage("Please provide order id")],
    checkErrors,
    updateOrder
  )
  .get("/whatsapp/campaigns", noCacheApiResponse, listOrderWhatsappCampaignsController)
  .get("/whatsapp/outbound", noCacheApiResponse, listOrderWhatsappOutboundController)
  .post("/whatsapp/send-selected", sendSelectedOrdersWhatsappController)
  .get("/:orderId/timeline", getPlantOrderTimeline)
  .post("/:orderId/send-accepted-whatsapp", sendOrderAcceptedWhatsAppController)
  .post("/:orderId/send-placed-whatsapp", sendOrderPlacedWhatsAppController)
  .post("/:orderId/send-dispatch-whatsapp", sendOrderDispatchWhatsAppController)
  .post("/:orderId/send-farm-ready-whatsapp", sendOrderFarmReadyWhatsAppController)
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
  .post("/dealer-order", uploadImages.array('screenshots', 10), createDealerOrder)
  .patch("/afterOrder",addAfterDispatchedOrderIds)
  .post("/:orderId/split", authenticateToken, splitOrder)

export default router;

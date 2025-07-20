import express from "express";
import {
  createUser,
  updateUser,
  deleteUser,
  findUser,
  login,
  testLogin,
  encryptPassword,
  getUsers,
  changePassword,
  resetPasswordForUser,
  aboutMe,
  getSalespeople,
  getSalesAnalytics,
  getAllDealersWithWalletInfo,
  getDealerWalletTransactions,
  exportDealerWalletTransactionsCSV,
  getDealerWalletStats,
  refreshToken,
  logout,
  verifyToken,
} from "../controllers/user.controller.js";
import { check } from "express-validator";
import checkErrors from "../middlewares/checkErrors.middleware.js";
import { authenticateToken, validateAuthRequest } from "../middlewares/auth.middleware.js";
import logger from "../middlewares/logger.middleware.js";
import {
  getDealerWalletDetails,
  getDealerWalletSummary,
} from "../controllers/walletController.js";
import catchAsync from "../utility/catchAsync.js";

const router = express.Router();

router.post("/login", login);
router.get("/test-login", testLogin);

router
  .post("/refresh-token", refreshToken)
  .post("/logout", authenticateToken, logout)
  .post("/verify-token", verifyToken)
  .post("/change-password", authenticateToken, changePassword)
  .post("/reset-password/:userId", authenticateToken, resetPasswordForUser)
  .post(
    "/createUser",
    [
      check("name", "Please provide valid name").notEmpty(),
      check("phoneNumber", "Please provide valid phoneNumber").notEmpty(),
    ],
    checkErrors,
    encryptPassword,
    // logger,
    createUser
  )
  .patch(
    "/updateUser",
    authenticateToken,
    [check("id", "Please provide valid userId").isMongoId()],
    encryptPassword,
    checkErrors,
    updateUser
  )
  .delete(
    "/deleteUser",
    authenticateToken,
    [check("id", "Please provide valid userId").isMongoId()],
    checkErrors,
    deleteUser
  )
  .get("/allusers", authenticateToken, getUsers)
  .get("/aboutMe", authenticateToken, aboutMe)
  .get("/wallet-details/:dealerId", getDealerWalletDetails)
  .get("/wallet-details-summary", getDealerWalletSummary)
  .get("/salespeople", getSalespeople)
  .get("/analytics/sales", getSalesAnalytics)
  .get("/dealers", getAllDealersWithWalletInfo)
  .get("/dealers/:dealerId", getDealerWalletDetails)
  .get("/dealers/transactions/:dealerId", getDealerWalletTransactions)
  .get("/dealers/transactions/:dealerId/csv", exportDealerWalletTransactionsCSV)
  .get("/dealerssss/stats", getDealerWalletStats)
  .get("/dealerssss/stats/:dealerId", getDealerWalletStats);
export default router;

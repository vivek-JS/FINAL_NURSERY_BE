import express from "express";
import {
  createUser,
  updateUser,
  deleteUser,
  findUser,
  login,
  encryptPassword,
  getUsers,
  resetPassword,
  aboutMe,
  getSalespeople,
  getSalesAnalytics,
  getAllDealersWithWalletInfo,
  getDealerWalletTransactions,
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

router
  .post("/refresh-token", refreshToken)
  .post("/logout", authenticateToken, logout)
  .post("/verify-token", verifyToken)
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
  .post("/resetPassword", authenticateToken, resetPassword)
  .get("/aboutMe", authenticateToken, aboutMe)
  .get("/wallet-details/:dealerId", getDealerWalletDetails)
  .get("/wallet-details-summary", getDealerWalletSummary)
  .get("/salespeople", getSalespeople)
  .get("/analytics/sales", getSalesAnalytics)
  .get("/dealers", getAllDealersWithWalletInfo)
  .get("/dealers/:dealerId", getDealerWalletDetails)
  .get("/dealers/transactions/:dealerId", getDealerWalletTransactions)
  .get("/dealerssss/stats", getDealerWalletStats)
  .get("/dealerssss/stats/:dealerId", getDealerWalletStats);
export default router;

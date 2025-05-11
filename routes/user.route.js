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
} from "../controllers/user.controller.js";
import { check } from "express-validator";
import checkErrors from "../middlewares/checkErrors.middleware.js";
import verifyToken from "../middlewares/verifyToken.middleware.js";
import logger from "../middlewares/logger.middleware.js";
import {
  getDealerWalletDetails,
  getDealerWalletSummary,
} from "../controllers/walletController.js";

const router = express.Router();

router
  .post(
    "/login",
    [
      check("phoneNumber", "Please provide valid email").isMobilePhone(),
      check("password", "Please provide valid password").notEmpty(),
    ],
    login
  )
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
    [check("id", "Please provide valid userId").isMongoId()],
    encryptPassword,
    checkErrors,
    updateUser
  )
  .delete(
    "/deleteUser",
    [check("id", "Please provide valid userId").isMongoId()],
    checkErrors,
    deleteUser
  )
  .get("/allusers", getUsers)
  .post("/resetPassword", resetPassword)
  .get("/aboutMe", aboutMe)
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

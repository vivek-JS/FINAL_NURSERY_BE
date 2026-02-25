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
  resetAllDealerPasswords,
  resetAllDispatchManagerPasswords,
  aboutMe,
  getSalespeople,
  getSalesAnalytics,
  getAllDealersWithWalletInfo,
  getDealerWalletTransactions,
  getDealerLedger,
  exportDealerWalletTransactionsCSV,
  getDealerWalletStats,
  refreshToken,
  logout,
  verifyToken,
  uploadMedia,
  processOCR,
} from "../controllers/user.controller.js";
import { check } from "express-validator";
import checkErrors from "../middlewares/checkErrors.middleware.js";
import { authenticateToken, validateAuthRequest } from "../middlewares/auth.middleware.js";
import logger from "../middlewares/logger.middleware.js";
import {
  getDealerWalletDetails,
  getDealerWalletSummary,
} from "../controllers/walletController.js";
import { getDealerPlantLedger } from "../controllers/dealerPlantInventoryLedger.controller.js";
import catchAsync from "../utility/catchAsync.js";
import { savePushToken } from "../controllers/notification.controller.js";
import multer from "multer";

const router = express.Router();

// Multer for media uploads (memory storage for Cloudinary)
const uploadMediaFile = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 }, // 8MB
  fileFilter: (req, file, cb) => {
    const ok = ["image/jpeg", "image/png", "image/webp", "image/avif", "image/gif"].includes(file.mimetype);
    cb(ok ? null : new Error("Only JPG/PNG/WEBP/AVIF/GIF allowed"), ok);
  },
});

router.post("/login", login);
router.get("/test-login", testLogin);

router
  .post("/refresh-token", refreshToken)
  .post("/logout", authenticateToken, logout)
  .post("/verify-token", verifyToken)
  .post("/change-password", authenticateToken, changePassword)
  .post("/reset-password/:userId", authenticateToken, resetPasswordForUser)
  .post("/reset-all-dealer-passwords", authenticateToken, resetAllDealerPasswords)
  .post("/reset-all-dispatch-manager-passwords", authenticateToken, resetAllDispatchManagerPasswords)
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
  .get("/dealers/stats", getDealerWalletStats)
  .get("/dealers/stats/:dealerId", getDealerWalletStats)
  .get("/dealers/transactions/:dealerId", getDealerWalletTransactions)
  .get("/dealers/transactions/:dealerId/csv", exportDealerWalletTransactionsCSV)
  .get("/dealers/:dealerId/ledger", getDealerLedger)
  .get("/dealers/:dealerId/plant-ledger", getDealerPlantLedger)
  .get("/dealers/:dealerId", getDealerWalletDetails)
  .post("/push-token", authenticateToken, savePushToken)
  .post("/media/", authenticateToken, uploadMediaFile.single("media_key"), uploadMedia)
  .post("/media/ocr", authenticateToken, processOCR);
export default router;

import express from "express";
import multer from "multer";
import {
  extractUpiReceipt,
  extractUpiReceiptByUrl,
  extractTransactionFromReceipt,
} from "../controllers/ocr.controller.js";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!file.mimetype || !file.mimetype.startsWith("image/")) {
      cb(new Error("Only image files are allowed"));
      return;
    }
    cb(null, true);
  },
});

const router = express.Router();

router.post(
  "/upi-receipt-by-url",
  express.json({ limit: "64kb" }),
  extractUpiReceiptByUrl
);

router.post("/upi-receipt", (req, res, next) => {
  upload.single("image")(req, res, (err) => {
    if (err) {
      return res.status(400).json({
        success: false,
        error: err.message || "File upload failed",
      });
    }
    next();
  });
}, extractUpiReceipt);

// Additive endpoint (spec section 7) — richer transaction schema, multipart "image".
router.post("/transaction", (req, res, next) => {
  upload.single("image")(req, res, (err) => {
    if (err) {
      return res.status(400).json({
        success: false,
        error: err.message || "File upload failed",
      });
    }
    next();
  });
}, extractTransactionFromReceipt);

export default router;

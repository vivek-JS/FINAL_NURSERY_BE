import express from "express";
import { createBackup, addBackup } from "../controllers/backup.controller.js";
import multer from "multer";
import path from "path";

const router = express.Router();

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, "./public/uploads/"); // Directory where files will be stored
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + path.extname(file.originalname);
    cb(null, file.fieldname + "-" + uniqueSuffix);
  },
});

const upload = multer({
  storage: storage,
  fileFilter: (req, file, cb) => {
    const filetypes = /zip/; // Accept only .zip files
    const mimetype = filetypes.test(file.mimetype);
    const extname = filetypes.test(
      path.extname(file.originalname).toLowerCase()
    );

    if (mimetype && extname) {
      return cb(null, true);
    }
    cb(new Error("Only .zip files are allowed!"));
  },
});

router
  .get("/generateBackup", createBackup)
  .post("/importBackup", upload.single("backup"), addBackup);

export default router;

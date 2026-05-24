import express from "express";
import generateResponse from "../utility/responseFormat.js";
import {
  createBackup,
  getBackupList,
  downloadBackup,
} from "../controllers/backup.controller.js";

const router = express.Router();

const SUPER_ADMIN_ROLES = ["SUPER_ADMIN", "SUPERADMIN"];

router.use((req, res, next) => {
  if (!req.user) {
    return res.status(401).json(
      generateResponse("error", "Authentication required", null, null)
    );
  }

  const userRoles = [req.user.role, req.user.jobTitle].filter(Boolean);
  const allowed = userRoles.some((r) => SUPER_ADMIN_ROLES.includes(r));

  if (!allowed) {
    return res.status(403).json(
      generateResponse("error", "Insufficient permissions — SUPER_ADMIN only", null, null)
    );
  }

  return next();
});

router.post("/create", createBackup);
router.get("/list", getBackupList);
router.get("/download/:filename", downloadBackup);

export default router;

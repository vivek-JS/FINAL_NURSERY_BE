import express from "express";
import multer from "multer";
import { authenticateToken } from "../middlewares/auth.middleware.js";
import {
  addFieldFollowUp,
  createFieldLead,
  fieldLeadsBoard,
  getFieldLead,
  lookupFieldLead,
  myPublicLinks,
  todayFieldLeads,
} from "../controllers/fieldLead.controller.js";
import { authorizeRoles } from "../middlewares/auth.middleware.js";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 },
});

const router = express.Router();

router.use(authenticateToken);
router.get("/lookup", lookupFieldLead);
router.get("/today", todayFieldLeads);
router.get("/links", myPublicLinks);
router.get(
  "/board",
  authorizeRoles(["SUPER_ADMIN", "SUPERADMIN", "ADMIN"]),
  fieldLeadsBoard
);
router.get("/:id", getFieldLead);
router.post(
  "/",
  upload.fields([
    { name: "photos", maxCount: 4 },
    { name: "audio", maxCount: 1 },
  ]),
  createFieldLead
);
router.post(
  "/:id/follow-ups",
  upload.fields([
    { name: "photos", maxCount: 4 },
    { name: "audio", maxCount: 1 },
  ]),
  addFieldFollowUp
);

export default router;

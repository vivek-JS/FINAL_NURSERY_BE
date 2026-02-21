import express from "express";
import multer from "multer";
import {
  createCampaign,
  listCampaigns,
  getCampaign,
  startCampaign,
  pauseCampaign,
  stopCampaign,
  resumeCampaign,
  campaignHistory,
  exportCampaignCsv,
  uploadAndCreateCampaign,
  getCampaignTargets,
} from "../controllers/campaign.controller.js";

const router = express.Router();
const upload = multer();

// Mirror of /api/v1/campaigns but under /api/v1/whatsapp/campaigns for frontend compatibility
router.post("/upload-and-create", upload.single("file"), uploadAndCreateCampaign);
router.post("/", upload.any(), createCampaign);
router.get("/targets", getCampaignTargets);
router.get("/:id/targets", getCampaignTargets);
router.get("/", listCampaigns);
router.get("/:id", getCampaign);
router.post("/:id/start", startCampaign);
router.post("/:id/pause", pauseCampaign);
router.post("/:id/stop", stopCampaign);
router.post("/:id/resume", resumeCampaign);
router.get("/:id/history", campaignHistory);
router.get("/:id/export", exportCampaignCsv);

export default router;


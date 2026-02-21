import express from "express";
import {
  createCampaign,
  listCampaigns,
  getCampaign,
  startCampaign,
  runNowCampaign,
  resumeWebCampaign,
  pauseCampaign,
  stopCampaign,
  resumeCampaign,
  resetTargetsCampaign,
  campaignHistory,
  exportCampaignCsv,
  updateCampaign,
  updateTargetsStatus,
  createCampaignRaw,
  getCampaignTargets,
  uploadAndCreateCampaign,
} from "../controllers/campaign.controller.js";

const router = express.Router();

import multer from "multer";
const upload = multer();
router.post("/upload-and-create", upload.single("file"), uploadAndCreateCampaign); // multipart upload -> create campaign
router.post("/", upload.any(), createCampaign);
// Raw multipart fallback for clients that POST malformed multipart (uses express.text)
router.post("/raw", express.text({ type: "*/*" }), createCampaignRaw);
router.get("/", listCampaigns);
// targets endpoints (support query param campaignId or path param)
router.get("/targets", getCampaignTargets);
router.get("/:id/targets", getCampaignTargets);
router.get("/:id", getCampaign);
router.patch("/:id", updateCampaign);
router.patch("/:id/targets", updateTargetsStatus);
router.post("/:id/start", startCampaign);
router.post("/:id/run-now", runNowCampaign);
router.post("/:id/resume-web", resumeWebCampaign);
router.post("/:id/pause", pauseCampaign);
router.post("/:id/stop", stopCampaign);
router.post("/:id/reset-targets", resetTargetsCampaign);
router.post("/:id/resume", resumeCampaign);
router.get("/:id/history", campaignHistory);
router.get("/:id/export", exportCampaignCsv);

export default router;


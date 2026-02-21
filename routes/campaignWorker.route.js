import express from "express";
import { claimCampaignRun, completeCampaignRun } from "../controllers/campaign.controller.js";
import { downloadCampaignRunner } from "../controllers/campaignWorker.controller.js";

const router = express.Router();

router.get("/claim", claimCampaignRun);
router.patch("/complete/:id", completeCampaignRun);
router.get("/download", downloadCampaignRunner);

export default router;

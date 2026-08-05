import express from "express";
import {
  getAgriLoadLinkPreview,
  postAgriLoadLinkConfirm,
  markLinkedAgriLoadedViaLink,
} from "../controllers/agriLoadLink.controller.js";

const router = express.Router();

router.get("/preview", getAgriLoadLinkPreview);
router.post("/confirm", postAgriLoadLinkConfirm);
router.get("/mark-loaded", markLinkedAgriLoadedViaLink);

export default router;

import express from "express";
import { listProfiles, createProfile, updateProfile, deleteProfile } from "../controllers/profile.controller.js";

const router = express.Router();

router.get("/", listProfiles);
router.post("/", createProfile);
router.patch("/:id", updateProfile);
router.delete("/:id", deleteProfile);

export default router;


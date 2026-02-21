import express from "express";
import { uploadMedia, listMedia } from "../controllers/media.controller.js";

const router = express.Router();

router.post("/upload", uploadMedia);
router.get("/", listMedia);

export default router;


import express from "express";
import {
  uploadAndCreateJob,
  createJob,
  startJob,
  pauseJob,
  getJob,
  jobHistory,
  getJobs,
  exportJobCsv,
} from "../controllers/automation.controller.js";

const router = express.Router();

// Upload Excel and create job in one request (multipart form, field: file)
router.post("/upload-and-create", uploadAndCreateJob);

// Create job directly with targets in body
router.post("/", createJob);

router.post("/:id/start", startJob);
router.post("/:id/pause", pauseJob);
router.get("/:id", getJob);
router.get("/:id/history", jobHistory);
router.get("/", getJobs);
router.get("/:id/export", exportJobCsv);

export default router;


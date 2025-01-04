import express from "express";
import {
  createDispatch,
  updateDispatch,
  getDispatches,
  getDispatch,
  removeTransport,
} from "../controllers/dispatch.controller.js";

const router = express.Router();

// Protected routes (require authentication)

// GET all dispatches
router.get("/", getDispatches);

// GET single dispatch
router.get("/:id", getDispatch);

// POST create new dispatch
router.post("/", createDispatch);

// PATCH update dispatch
router.patch("/:id", updateDispatch);
router.delete("/transport/:transportId", removeTransport);

export default router;

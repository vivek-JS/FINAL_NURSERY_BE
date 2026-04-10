import express from "express";
import {
  createDispatch,
  updateDispatch,
  addOrderToDispatch,
  getDispatches,
  getDispatch,
  removeTransport,
  handleDispatchReturns,
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
// PATCH add a post-dispatch (quick) order to a vehicle — safe from mongo-sanitize
router.patch("/:id/add-order", addOrderToDispatch);
router.delete("/transport/:transportId", removeTransport);
router.patch("/complete/:id", handleDispatchReturns);

export default router;

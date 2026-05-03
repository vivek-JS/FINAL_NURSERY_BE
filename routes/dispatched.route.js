import express from "express";
import {
  createDispatch,
  updateDispatch,
  addOrderToDispatch,
  getDispatches,
  getDispatch,
  removeTransport,
  handleDispatchReturns,
  assignRoute,
  bulkMarkReady,
  detachOrderFromDispatch,
} from "../controllers/dispatch.controller.js";

const router = express.Router();

// GET all dispatches
router.get("/", getDispatches);

// GET single dispatch
router.get("/:id", getDispatch);

// POST create new dispatch
router.post("/", createDispatch);

// PATCH pre-dispatch: assign vehicle + driver to orders from the map planner
router.patch("/assign-route", assignRoute);

// PATCH bulk move orders to READY_FOR_DISPATCH
router.patch("/bulk-mark-ready", bulkMarkReady);

// PATCH update dispatch
router.patch("/:id", updateDispatch);
// PATCH add a post-dispatch (quick) order to a vehicle — safe from mongo-sanitize
router.patch("/:id/add-order", addOrderToDispatch);
router.patch("/:id/detach-order", detachOrderFromDispatch);
router.delete("/transport/:transportId", removeTransport);
router.patch("/complete/:id", handleDispatchReturns);

export default router;

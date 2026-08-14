import express from "express";
import {
  createDispatch,
  updateDispatch,
  addOrderToDispatch,
  getDispatches,
  getDispatch,
  regenerateDispatchPdfs,
  ensureDispatchDeliveryChallanNumbers,
  removeTransport,
  handleDispatchReturns,
  assignRoute,
  bulkMarkReady,
  detachOrderFromDispatch,
  getGiftProductsInStock,
  syncDispatchOrderGifts,
} from "../controllers/dispatch.controller.js";
import { reassignRefusedDelivery } from "../controllers/dispatchReassign.controller.js";

const router = express.Router();

// GET all dispatches
router.get("/", getDispatches);

// GET gift inventory products with stock > 0 (for dispatch order gifts)
router.get("/gift-products-in-stock", getGiftProductsInStock);

// POST sync linked gift lines for nursery orders on a dispatch
router.post("/sync-order-gifts", syncDispatchOrderGifts);

// POST generate PDFs (before GET /:id so "generate-pdfs" is never captured as :id)
router.post("/:id/generate-pdfs", regenerateDispatchPdfs);

// POST ensure CMS DC numbers on dispatch orders (before challan preview)
router.post("/:id/ensure-delivery-challan-numbers", ensureDispatchDeliveryChallanNumbers);

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
// PATCH reassign a refused delivery: cancel/keep original orders + create off-slot field orders
router.patch("/:id/reassign-refused", reassignRefusedDelivery);
router.delete("/transport/:transportId", removeTransport);
router.patch("/complete/:id", handleDispatchReturns);

export default router;

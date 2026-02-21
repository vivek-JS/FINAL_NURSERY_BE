import express from "express";
import { authenticateToken } from "../middlewares/auth.middleware.js";
import {
  getCombinedList,
  getFilterValues,
  assignList,
  getLists,
  getListById,
  getListForMobile,
  addCallLog,
  getProgress,
} from "../controllers/callAssignment.controller.js";

const router = express.Router();

router.use(authenticateToken);

router.get("/filter-values", getFilterValues);
router.get("/combined", getCombinedList);
router.post("/assign", assignList);
router.get("/lists", getLists);
router.get("/lists/progress", getProgress);
router.get("/lists/:id", getListById);
router.get("/lists/:id/mobile", getListForMobile);
router.post("/lists/:id/call-log", addCallLog);

export default router;

import express from "express";
import { authorizeRoles } from "../middlewares/auth.middleware.js";
import {
  listFreightRateCards,
  createFreightRateCard,
  updateFreightRateCard,
  deleteFreightRateCard,
  restoreDefaultFreightRateCards,
} from "../controllers/freightRateCard.controller.js";

const router = express.Router();
const canEdit = authorizeRoles(["SUPER_ADMIN", "ADMIN", "OFFICE_ADMIN", "ACCOUNTANT"]);

router.get("/", listFreightRateCards);
router.post("/", canEdit, createFreightRateCard);
router.post("/restore-defaults", canEdit, restoreDefaultFreightRateCards);
router.patch("/:id", canEdit, updateFreightRateCard);
router.delete("/:id", canEdit, deleteFreightRateCard);

export default router;

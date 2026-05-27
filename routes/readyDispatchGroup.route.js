import express from "express";
import {
  suggestReadyDispatchGroups,
  createReadyDispatchGroups,
  getReadyDispatchGroups,
  getReadyDispatchGroupById,
  updateReadyDispatchGroup,
  convertReadyDispatchGroupToDispatch,
} from "../controllers/readyDispatchGroup.controller.js";

const router = express.Router();

router.post("/suggest", suggestReadyDispatchGroups);
router.post("/", createReadyDispatchGroups);
router.get("/", getReadyDispatchGroups);
router.get("/:id", getReadyDispatchGroupById);
router.patch("/:id", updateReadyDispatchGroup);
router.post("/:id/convert-to-dispatch", convertReadyDispatchGroupToDispatch);

export default router;

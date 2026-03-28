import express from "express";
import {
  suggestReadyDispatchGroups,
  createReadyDispatchGroups,
  getReadyDispatchGroups,
  updateReadyDispatchGroup,
  convertReadyDispatchGroupToDispatch,
} from "../controllers/readyDispatchGroup.controller.js";

const router = express.Router();

router.post("/suggest", suggestReadyDispatchGroups);
router.post("/", createReadyDispatchGroups);
router.get("/", getReadyDispatchGroups);
router.patch("/:id", updateReadyDispatchGroup);
router.post("/:id/convert-to-dispatch", convertReadyDispatchGroupToDispatch);

export default router;

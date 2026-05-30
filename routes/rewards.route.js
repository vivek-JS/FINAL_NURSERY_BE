import express from "express";
import { authenticateToken, authorizeRoles } from "../middlewares/auth.middleware.js";
import {
  getRewardMeta,
  listPrograms,
  createProgram,
  updateProgram,
  deleteProgram,
  getProgramParticipants,
  patchUserProgress,
  refreshProgramProgress,
  getMyPrograms,
  getMyProgramById,
} from "../controllers/rewards.controller.js";

const router = express.Router();

const requireRewardsAdmin = authorizeRoles([
  "SUPER_ADMIN",
  "SUPERADMIN",
  "ADMIN",
  "OFFICE_ADMIN",
]);

router.use(authenticateToken);

router.get("/meta", getRewardMeta);

router.get("/my-programs", getMyPrograms);
router.get("/my-programs/:id", getMyProgramById);

router.use(requireRewardsAdmin);

router.get("/programs", listPrograms);
router.post("/programs", createProgram);
router.put("/programs/:id", updateProgram);
router.delete("/programs/:id", deleteProgram);
router.get("/programs/:id/participants", getProgramParticipants);
router.post("/programs/:id/refresh-progress", refreshProgramProgress);
router.patch("/programs/:programId/progress/:userId", patchUserProgress);

export default router;

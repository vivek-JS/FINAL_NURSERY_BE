import express from "express";
import {
  createChemical,
  updateChemical,
  deleteChemical,
} from "../controllers/chemical.controller.js";

const router = express.Router();

router
  .post("/createChemical", createChemical)
  .patch("/updateChemical", updateChemical)
  .delete("/deleteChemical", deleteChemical);

export default router;

import express from "express";
import {
  createVegetable,
  updateVegetable,
  deleteVegetable,
} from "../controllers/vegetable.controller.js";

const router = express.Router();

router
  .post("/createVegetable", createVegetable)
  .patch("/updateVegetable", updateVegetable)
  .delete("/deleteVegetable", deleteVegetable);

export default router;

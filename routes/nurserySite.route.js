import express from "express";
import {
  listNurserySites,
  createNurserySite,
  updateNurserySite,
  deleteNurserySite,
} from "../controllers/nurserySite.controller.js";

const router = express.Router();

router.get("/", listNurserySites);
router.post("/", createNurserySite);
router.patch("/:id", updateNurserySite);
router.delete("/:id", deleteNurserySite);

export default router;

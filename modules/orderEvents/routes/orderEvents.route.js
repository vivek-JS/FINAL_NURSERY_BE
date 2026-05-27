import express from "express";
import { listOrderEvents } from "../api/orderEvents.controller.js";

const router = express.Router();

router.get("/", listOrderEvents);

export default router;

import {
  createGodownStockInward,
  updateGodownStockInward,
  deleteGodownStockInward,
  getGodownStockInward,
  createGodownStockOutward,
  updateGodownStockOutward,
  deleteGodownStockOutward,
  getGodownStockOutward,
} from "../controllers/godown.controller.js";
import express from "express";
import { check } from "express-validator";
import checkErrors from "../middlewares/checkErrors.middleware.js";

const godownRouter = express.Router();

godownRouter
  .get("/getGodownStockInward", getGodownStockInward)
  .post("/createGodownStockInward", createGodownStockInward)
  .patch("/updateGodownStockInward", updateGodownStockInward)
  .delete("/deleteGodownStockInward", deleteGodownStockInward)
  .get("/getGodownStockOutward", getGodownStockOutward)
  .post("/createGodownStockOutward", createGodownStockOutward)
  .patch("/updateGodownStockOutward", updateGodownStockOutward)
  .delete("/deleteGodownStockOutward", deleteGodownStockOutward);

export default godownRouter;

import {
  GodownStockInward,
  GodownStockOutward,
} from "../models/godown.model.js";
import { createOne, updateOne, deleteOne } from "./factory.controller.js";

/*
  -godown stock inward controllers
*/

const createGodownStockInward = createOne(
  GodownStockInward,
  "GodownStockInward"
);
const updateGodownStockInward = updateOne(
  GodownStockInward,
  "GodownStockInward"
);
const deleteGodownStockInward = deleteOne(
  GodownStockInward,
  "GodownStockInward"
);
const getGodownStockInward = () => {};

/*
  -godown stock outward controllers
*/

const createGodownStockOutward = createOne(
  GodownStockOutward,
  "GodownStockOutward"
);
const updateGodownStockOutward = updateOne(
  GodownStockOutward,
  "GodownStockOutward"
);
const deleteGodownStockOutward = deleteOne(
  GodownStockOutward,
  "GodownStockOutward"
);
const getGodownStockOutward = () => {};

export {
  createGodownStockInward,
  updateGodownStockInward,
  deleteGodownStockInward,
  getGodownStockInward,
  createGodownStockOutward,
  updateGodownStockOutward,
  deleteGodownStockOutward,
  getGodownStockOutward,
};

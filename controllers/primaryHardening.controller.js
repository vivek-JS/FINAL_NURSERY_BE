import PrimaryHardening from "../models/primayHardeing.model.js";
import {
  createOne,
  updateOne,
  deleteOne,
  getOne,
  getAll,
} from "../controllers/factory.controller.js";

const createPrimaryHardening = createOne(PrimaryHardening, "PrimaryHardening");
const updatePrimaryHardening = updateOne(PrimaryHardening, "PrimaryHardening");
const deletePrimaryHardening = deleteOne(PrimaryHardening, "PrimaryHardening");
const getPrimaryHardening = getOne(PrimaryHardening, "PrimaryHardening");
const getAllPrimaryHardening = getAll(PrimaryHardening, "PrimaryHardening");

export {
  createPrimaryHardening,
  updatePrimaryHardening,
  deletePrimaryHardening,
  getPrimaryHardening,
  getAllPrimaryHardening,
};

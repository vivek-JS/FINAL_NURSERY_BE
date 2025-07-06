import SecondaryHardening from "../models/secondaryHardening.model.js";
import {
  createOne,
  updateOne,
  deleteOne,
  getOne,
  getAll,
} from "../controllers/factory.controller.js";

const createSecondaryHardening = createOne(
  SecondaryHardening,
  "SecondaryHardening"
);
const updateSecondaryHardening = updateOne(
  SecondaryHardening,
  "SecondaryHardening"
);
const deleteSecondaryHardening = deleteOne(
  SecondaryHardening,
  "SecondaryHardening"
);
const getSecondaryHardening = getOne(SecondaryHardening, "SecondaryHardening");
const getAllSecondaryHardening = getAll(
  SecondaryHardening,
  "SecondaryHardening"
);

export {
  createSecondaryHardening,
  updateSecondaryHardening,
  deleteSecondaryHardening,
  getSecondaryHardening,
  getAllSecondaryHardening,
};

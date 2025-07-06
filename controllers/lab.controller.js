import Lab from "../models/lab.model.js";
import {
  createOne,
  deleteOne,
  updateOneNestedData,
} from "./factory.controller.js";

const createLab = createOne(Lab, "Lab");
const updateLab = updateOneNestedData(Lab, "Lab");
const deleteLab = deleteOne(Lab, "Lab");
const getLab = () => {};

export { createLab, updateLab, deleteLab, getLab };

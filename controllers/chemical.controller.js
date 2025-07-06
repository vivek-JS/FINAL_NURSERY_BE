import Chemical from "../models/chemical.model.js";
import { createOne, updateOne, deleteOne } from "./factory.controller.js";

const createChemical = createOne(Chemical, "Chemical");
const updateChemical = updateOne(Chemical, "Chemical");
const deleteChemical = deleteOne(Chemical, "Chemical");

export { createChemical, updateChemical, deleteChemical };

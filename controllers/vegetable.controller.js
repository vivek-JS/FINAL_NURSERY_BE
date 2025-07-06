import Vegetable from "../models/vegetables.model.js";
import { createOne, updateOne, deleteOne } from "./factory.controller.js";

const createVegetable = createOne(Vegetable, "Vegetable");
const updateVegetable = updateOne(Vegetable, "Vegetable");
const deleteVegetable = deleteOne(Vegetable, "Vegetable");

export { createVegetable, updateVegetable, deleteVegetable };

import { SeedInward, SeedOutward } from "../models/seed.model.js";
import { createOne, updateOne, deleteOne } from "./factory.controller.js";

/*
    -seed inward controllers
*/

const createSeedInward = createOne(SeedInward, "SeedInward");
const updateSeedInward = updateOne(SeedInward, "SeedInward");
const deleteSeedInward = deleteOne(SeedInward, "SeedInward");
const getSeedInward = () => {};

/*
    -seed outward outward controllers
*/

const createSeedOutward = createOne(SeedOutward, "SeedOutward");
const updateSeedOutward = updateOne(SeedOutward, "SeedOutward");
const deleteSeedOutward = deleteOne(SeedOutward, "SeedOutward");
const getSeedOutward = () => {};

export {
  createSeedInward,
  updateSeedInward,
  deleteSeedInward,
  getSeedInward,
  createSeedOutward,
  updateSeedOutward,
  deleteSeedOutward,
  getSeedOutward,
};

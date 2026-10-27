import mongoose from "mongoose";
import PlantCms from "../models/plantCms.model.js";

/** Prefer Plant CMS sowingMortality; fall back to sowingBuffer. */
export function plantMortalityPct(plant) {
  if (plant?.sowingMortality != null && Number.isFinite(Number(plant.sowingMortality))) {
    return Math.max(0, Number(plant.sowingMortality));
  }
  if (plant?.sowingBuffer != null && Number.isFinite(Number(plant.sowingBuffer))) {
    return Math.max(0, Number(plant.sowingBuffer));
  }
  return 0;
}

/** plantId → mortality % from Plant CMS. Missing plants are 0. */
export async function sowingBufferPctByPlantId(plantIds) {
  const ids = [
    ...new Set(
      (plantIds || [])
        .map((id) => String(id || ""))
        .filter((id) => mongoose.Types.ObjectId.isValid(id))
    ),
  ];
  if (!ids.length) return new Map();
  const rows = await PlantCms.find({ _id: { $in: ids } })
    .select("sowingMortality sowingBuffer")
    .lean();
  return new Map(rows.map((plant) => [String(plant._id), plantMortalityPct(plant)]));
}

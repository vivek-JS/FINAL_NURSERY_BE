import mongoose from "mongoose";
import PlantCms from "../models/plantCms.model.js";

/** plantId → sowingBuffer percent from Plant CMS. Missing plants are 0. */
export async function sowingBufferPctByPlantId(plantIds) {
  const ids = [
    ...new Set(
      (plantIds || [])
        .map((id) => String(id || ""))
        .filter((id) => mongoose.Types.ObjectId.isValid(id))
    ),
  ];
  if (!ids.length) return new Map();
  const rows = await PlantCms.find({ _id: { $in: ids } }).select("sowingBuffer").lean();
  return new Map(
    rows.map((plant) => [String(plant._id), Math.max(0, Number(plant.sowingBuffer) || 0)])
  );
}

import mongoose from "mongoose";
import Dispatch from "../models/dispatch.model.js";

export async function uploadVehicleLoadPhotoFiles(files) {
  if (!files?.length) return [];
  try {
    const { uploadMultipleImagesToLocalStorage } = await import(
      "../utils/localStorageUtils.js"
    );
    const uploads = await uploadMultipleImagesToLocalStorage(
      files,
      "vehicle-load",
    );
    return (uploads || [])
      .filter((u) => u?.url)
      .map((u) => ({
        url: u.url,
        uploadedAt: new Date(),
      }));
  } catch (err) {
    console.warn("[vehicle-load] photo upload failed:", err?.message || err);
    return [];
  }
}

/**
 * Persist load photos on the vehicle dispatch after a successful shed load.
 * @returns {{ urls: string[], entry: object | null }}
 */
export async function appendVehicleLoadPhotos({
  dispatchId,
  files,
  plantsLoaded = 0,
  remarks = "",
  performedBy,
}) {
  const photos = await uploadVehicleLoadPhotoFiles(files);
  if (!photos.length) return { urls: [], entry: null };

  const entry = {
    photos,
    plantsLoaded: Math.max(0, Math.floor(Number(plantsLoaded) || 0)),
    remarks: String(remarks || "").trim(),
    uploadedBy:
      performedBy && mongoose.isValidObjectId(String(performedBy))
        ? performedBy
        : null,
    uploadedAt: new Date(),
  };

  await Dispatch.findByIdAndUpdate(dispatchId, {
    $push: { shedLoadPhotoLog: entry },
  });

  return { urls: photos.map((p) => p.url), entry };
}

import multer from "multer";
import AppError from "../utility/appError.js";

export const MAX_VEHICLE_LOAD_PHOTO_BYTES = 1024 * 1024;

export const vehicleLoadPhotosUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_VEHICLE_LOAD_PHOTO_BYTES, files: 10 },
});

/** Run multer only when client sends multipart (photos); JSON loads unchanged. */
export function optionalVehicleLoadPhotosUpload(req, res, next) {
  const ct = String(req.headers["content-type"] || "");
  if (!ct.includes("multipart/form-data")) return next();
  return vehicleLoadPhotosUpload.array("photos", 10)(req, res, (err) => {
    if (err?.code === "LIMIT_FILE_SIZE") {
      return next(new AppError("Photo must be 1 MB or less", 400));
    }
    if (err) return next(err);
    next();
  });
}

const JSON_ARRAY_FIELDS = [
  "inwardSelections",
  "shedLoads",
  "sowReadySelections",
];

/** Parse vehicle load body from multipart form fields (JSON strings) or JSON body. */
export function parseVehicleLoadRequestBody(raw = {}) {
  const body = { ...raw };

  for (const key of JSON_ARRAY_FIELDS) {
    const val = body[key];
    if (typeof val === "string" && val.trim()) {
      try {
        body[key] = JSON.parse(val);
      } catch {
        /* keep string — validation will fail downstream */
      }
    }
  }

  if (body.plantRowIndex != null && body.plantRowIndex !== "") {
    body.plantRowIndex = Number(body.plantRowIndex);
  }
  if (body.plants != null && body.plants !== "") {
    body.plants = Number(body.plants);
  }
  if (body.directShedLoad != null && body.directShedLoad !== "") {
    const s = String(body.directShedLoad).toLowerCase();
    body.directShedLoad = s === "true" || s === "1";
  }

  return body;
}

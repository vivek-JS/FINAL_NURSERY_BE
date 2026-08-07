import { toGreyscalePlane, toPreparedFaceImage } from "./faceImagePrep.js";

const MIN_BRIGHTNESS = 40; // mean luma 0-255; below this is "too dark"
const MAX_BRIGHTNESS = 220; // above this is likely blown-out / overexposed
// Calibrated empirically (see task notes): mean abs adjacent-pixel diff on an
// aspect-preserving resize to <=800px. Real sharp photos measured 3.2-8.3;
// synthetically blurred versions of the same photo (gaussian sigma 5-10)
// measured 2.0-2.5, so 2.2 cleanly separates "usable" from "clearly blurry".
const MIN_SHARPNESS_VARIANCE = 2.2;
const MIN_DIMENSION = 240; // px, guards against tiny/garbage uploads

/**
 * Lightweight brightness + blur heuristic on the greyscale plane (no extra native deps).
 * Blur proxy: mean absolute difference between adjacent pixels — a real Laplacian
 * would be more precise but this stays fast while still catching genuinely
 * blurry/flat-field photos.
 *
 * Accepts either an upload buffer or an image already decoded by `prepareFaceImage`,
 * so a request can share a single decode between quality checks and face detection.
 */
export async function assessImageQuality(input) {
  const prepared = await toPreparedFaceImage(input);
  const { width, height } = prepared;

  if (!width || !height || width < MIN_DIMENSION || height < MIN_DIMENSION) {
    return { ok: false, reason: "IMAGE_TOO_SMALL", prepared };
  }

  const data = await toGreyscalePlane(prepared);

  let sum = 0;
  for (let i = 0; i < data.length; i += 1) sum += data[i];
  const meanBrightness = sum / data.length;

  let diffSum = 0;
  let diffCount = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width - 1; x += 1) {
      const idx = y * width + x;
      diffSum += Math.abs(data[idx] - data[idx + 1]);
      diffCount += 1;
    }
  }
  const sharpnessScore = diffCount > 0 ? diffSum / diffCount : 0;

  if (meanBrightness < MIN_BRIGHTNESS) {
    return { ok: false, reason: "POOR_LIGHTING_TOO_DARK", meanBrightness, sharpnessScore, prepared };
  }
  if (meanBrightness > MAX_BRIGHTNESS) {
    return { ok: false, reason: "POOR_LIGHTING_OVEREXPOSED", meanBrightness, sharpnessScore, prepared };
  }
  if (sharpnessScore < MIN_SHARPNESS_VARIANCE) {
    return { ok: false, reason: "IMAGE_TOO_BLURRY", meanBrightness, sharpnessScore, prepared };
  }

  return { ok: true, meanBrightness, sharpnessScore, prepared };
}

/**
 * Face-bbox-relative distance heuristic ("too far" = tiny face in frame, "too
 * close" = face fills almost the entire frame and risks losing landmarks).
 */
export function assessFaceDistance(faceBox, imageWidth, imageHeight) {
  const faceAreaRatio = (faceBox.width * faceBox.height) / (imageWidth * imageHeight);

  if (faceAreaRatio < 0.04) {
    return { ok: false, reason: "FACE_TOO_FAR", faceAreaRatio };
  }
  if (faceAreaRatio > 0.85) {
    return { ok: false, reason: "FACE_TOO_CLOSE", faceAreaRatio };
  }
  return { ok: true, faceAreaRatio };
}

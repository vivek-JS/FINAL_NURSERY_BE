import sharp from "sharp";

const DEFAULT_MAX_DIMENSION = 800;
const MIN_ALLOWED_MAX_DIMENSION = 416; // TinyFaceDetector's own input size — going below only loses accuracy

export function getFaceDetectMaxDimension() {
  const configured = Number(process.env.FACE_DETECT_MAX_DIMENSION);
  if (!Number.isFinite(configured) || configured < MIN_ALLOWED_MAX_DIMENSION) return DEFAULT_MAX_DIMENSION;
  return Math.round(configured);
}

/**
 * Decodes, auto-orients and downscales an uploaded photo exactly once, returning
 * the raw RGB plane that both the quality heuristics and the face-api tensor consume.
 *
 * Downscaling matters more than it looks: a 12MP selfie turns into a ~144MB float32
 * tensor (plus the intermediate copy) while TinyFaceDetector resizes its input to
 * 416px internally anyway, so the extra pixels cost latency and memory headroom
 * without improving detection.
 */
export async function prepareFaceImage(buffer) {
  const maxDimension = getFaceDetectMaxDimension();

  const { data, info } = await sharp(buffer)
    .rotate() // honor EXIF orientation
    .removeAlpha()
    .toColorspace("srgb")
    .resize({ width: maxDimension, height: maxDimension, fit: "inside", withoutEnlargement: true })
    .raw()
    .toBuffer({ resolveWithObject: true });

  return { data, width: info.width, height: info.height, channels: info.channels };
}

/** True when a value already came from `prepareFaceImage` rather than being an upload buffer. */
export function isPreparedFaceImage(value) {
  return Boolean(value && typeof value === "object" && value.data && value.width && value.height);
}

/** Accepts either a raw upload buffer or an already-prepared image, so callers can share one decode. */
export async function toPreparedFaceImage(input) {
  return isPreparedFaceImage(input) ? input : prepareFaceImage(input);
}

/**
 * Greyscale plane derived from the already-decoded RGB data. Runs through sharp on
 * the raw pixels (no second JPEG decode) so the luma conversion stays identical to
 * what the blur/brightness thresholds were calibrated against.
 */
export async function toGreyscalePlane(prepared) {
  return sharp(prepared.data, {
    raw: { width: prepared.width, height: prepared.height, channels: prepared.channels },
  })
    .greyscale()
    .raw()
    .toBuffer();
}

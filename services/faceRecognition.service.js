import * as tf from "@tensorflow/tfjs";
import { setWasmPaths } from "@tensorflow/tfjs-backend-wasm";
// The default `@vladmandic/face-api` entry point hard-requires `@tensorflow/tfjs-node`
// (native bindings, Node <=22 only). The `node-wasm` build is prewired for the pure-JS
// WASM backend instead, matching the tfjs + tfjs-backend-wasm packages we install.
import * as faceapi from "@vladmandic/face-api/dist/face-api.node-wasm.js";
import path from "path";
import { fileURLToPath } from "url";
import AppError from "../utility/appError.js";
import { toPreparedFaceImage } from "../utility/faceImagePrep.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEIGHTS_DIR = path.join(__dirname, "..", "weights");
const WASM_DIR = path.join(__dirname, "..", "node_modules", "@tensorflow", "tfjs-backend-wasm", "dist") + "/";

const DETECTOR_INPUT_SIZE = 416; // must be a multiple of 32 for TinyFaceDetector
const DETECTOR_SCORE_THRESHOLD = 0.5;
/** Euclidean distance below which two descriptors are considered the same person (face-api convention). */
const DEFAULT_MATCH_THRESHOLD = 0.5;

let readyPromise = null;

function detectorOptions() {
  return new faceapi.TinyFaceDetectorOptions({
    inputSize: DETECTOR_INPUT_SIZE,
    scoreThreshold: DETECTOR_SCORE_THRESHOLD,
  });
}

/** Loads the TFJS WASM backend + the 3 face-api nets exactly once (subsequent calls await the same promise). */
export function ensureFaceModelsLoaded() {
  if (!readyPromise) {
    readyPromise = (async () => {
      setWasmPaths(WASM_DIR);
      await tf.setBackend("wasm");
      await tf.ready();

      await faceapi.nets.tinyFaceDetector.loadFromDisk(WEIGHTS_DIR);
      await faceapi.nets.faceLandmark68Net.loadFromDisk(WEIGHTS_DIR);
      await faceapi.nets.faceRecognitionNet.loadFromDisk(WEIGHTS_DIR);

      console.log(`[FaceRecognition] Models loaded — TFJS backend: ${tf.getBackend()}`);
    })().catch((err) => {
      readyPromise = null; // allow a retry on next call instead of permanently failing
      throw err;
    });
  }
  return readyPromise;
}

/**
 * Wraps a decoded RGB plane in a float32 [H, W, 3] tensor holding raw 0-255 values —
 * mirrors what `@tensorflow/tfjs-node`'s `tf.node.decodeImage` + cast produces in
 * face-api's own Node examples, without requiring tfjs-node's native bindings
 * (which don't support Node 24). Building the Float32Array directly avoids the
 * extra int32 tensor + cast the previous implementation allocated.
 */
function preparedToTensor(prepared) {
  return tf.tensor3d(
    new Float32Array(prepared.data),
    [prepared.height, prepared.width, prepared.channels],
    "float32"
  );
}

/**
 * Runs one throwaway inference so the very first real request doesn't pay for
 * WASM compilation and kernel setup. Safe to call repeatedly and never rejects —
 * a failed warmup just means the next real call loads the models lazily.
 */
export async function warmUpFaceModels() {
  try {
    await ensureFaceModelsLoaded();
    const tensor = tf.zeros([DETECTOR_INPUT_SIZE, DETECTOR_INPUT_SIZE, 3], "float32");
    try {
      await faceapi.detectAllFaces(tensor, detectorOptions()).withFaceLandmarks().withFaceDescriptors();
    } finally {
      tensor.dispose();
    }
    console.log("[FaceRecognition] Warmup complete — first attendance request will skip cold start");
    return true;
  } catch (err) {
    console.error("[FaceRecognition] Warmup failed (models will load on first request):", err?.message || err);
    return false;
  }
}

/**
 * Detects faces in an upload buffer (or an already-prepared image) and returns
 * landmarks + a 128-d descriptor for each, alongside the dimensions of the image
 * the boxes are expressed in — callers doing framing math must use these rather
 * than the original upload size, since the image is downscaled before detection.
 */
export async function detectFacesWithDescriptors(input) {
  await ensureFaceModelsLoaded();
  const prepared = await toPreparedFaceImage(input);
  const tensor = preparedToTensor(prepared);
  try {
    const detections = await faceapi
      .detectAllFaces(tensor, detectorOptions())
      .withFaceLandmarks()
      .withFaceDescriptors();
    return { detections, imageWidth: prepared.width, imageHeight: prepared.height };
  } finally {
    tensor.dispose();
  }
}

/**
 * Convenience wrapper enforcing "exactly one face" for registration/verification flows.
 * Returns `{ detection, imageWidth, imageHeight }` where the dimensions match the
 * coordinate space of `detection.detection.box`.
 */
export async function detectSingleFaceOrThrow(input) {
  const { detections, imageWidth, imageHeight } = await detectFacesWithDescriptors(input);

  if (detections.length === 0) {
    throw Object.assign(
      new AppError("No face detected in the photo. Please retake with your face clearly visible.", 422),
      { code: "NO_FACE" }
    );
  }
  if (detections.length > 1) {
    throw Object.assign(
      new AppError("Multiple faces detected. Please make sure only you are in frame.", 422),
      { code: "MULTIPLE_FACES" }
    );
  }

  return { detection: detections[0], imageWidth, imageHeight };
}

/** Euclidean distance between two 128-d descriptors (lower = more similar). */
export function descriptorDistance(a, b) {
  return faceapi.euclideanDistance(a, b);
}

/**
 * Compares a live descriptor against a set of stored descriptors and returns
 * the best (smallest-distance) match, converted to a 0-1 "match score".
 */
export function findBestMatch(liveDescriptor, storedDescriptors, threshold = getMatchThreshold()) {
  let bestDistance = Infinity;
  for (const stored of storedDescriptors) {
    const distance = descriptorDistance(liveDescriptor, stored);
    if (distance < bestDistance) bestDistance = distance;
  }

  const isMatch = bestDistance <= threshold;
  // Map distance→score so 0 distance = 1.0 score and `threshold` distance ≈ 0.5, never negative.
  const matchScore = Math.max(0, 1 - bestDistance / (threshold * 2));

  return { isMatch, distance: bestDistance, matchScore };
}

export function getMatchThreshold() {
  const envValue = Number(process.env.FACE_MATCH_THRESHOLD);
  return Number.isFinite(envValue) && envValue > 0 ? envValue : DEFAULT_MATCH_THRESHOLD;
}

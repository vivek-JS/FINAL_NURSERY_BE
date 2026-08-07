/**
 * HTTP client for the InsightFace FastAPI microservice.
 * Mirrors the pattern in ocrService.js — typed errors, timeout, API-key header.
 */

const DEFAULT_SERVICE_URL = "http://127.0.0.1:8020";
const DEFAULT_TIMEOUT_MS = 30000;

export class FaceServiceError extends Error {
  constructor(message, { cause, status, errorCode } = {}) {
    super(message);
    this.name = "FaceServiceError";
    this.status = status ?? null;
    this.errorCode = errorCode ?? null;
    if (cause) this.cause = cause;
  }
}

function getServiceUrl() {
  return (process.env.FACE_SERVICE_URL || DEFAULT_SERVICE_URL).replace(/\/+$/, "");
}

function getApiKey() {
  return process.env.FACE_SERVICE_API_KEY || "";
}

function getTimeoutMs() {
  const raw = Number(process.env.FACE_SERVICE_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TIMEOUT_MS;
}

function getMatchThreshold() {
  const raw = Number(process.env.FACE_MATCH_THRESHOLD);
  return Number.isFinite(raw) ? raw : 0.45;
}

function getDuplicateThreshold() {
  const raw = Number(process.env.FACE_DUPLICATE_THRESHOLD);
  return Number.isFinite(raw) ? raw : 0.55;
}

async function faceServiceFetch(path, { method = "GET", body, headers = {} } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), getTimeoutMs());

  try {
    const response = await fetch(`${getServiceUrl()}${path}`, {
      method,
      body,
      headers: {
        "X-API-Key": getApiKey(),
        ...headers,
      },
      signal: controller.signal,
    });

    const payload = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new FaceServiceError(payload.detail || payload.message || "Face service request failed", {
        status: response.status,
        errorCode: "FACE_SERVICE_UNAVAILABLE",
      });
    }

    return payload;
  } catch (err) {
    if (err instanceof FaceServiceError) throw err;
    if (err.name === "AbortError") {
      throw new FaceServiceError("Face service timed out", { errorCode: "FACE_SERVICE_UNAVAILABLE", cause: err });
    }
    throw new FaceServiceError("Face service is unavailable", { errorCode: "FACE_SERVICE_UNAVAILABLE", cause: err });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @param {Buffer[]} imageBuffers
 * @param {string} employeeId
 */
export async function registerFaceEmbeddings(imageBuffers, employeeId) {
  const form = new FormData();
  form.append("employee_id", employeeId);
  for (const buf of imageBuffers) {
    form.append("images", new Blob([buf], { type: "image/jpeg" }), "frame.jpg");
  }

  const result = await faceServiceFetch("/face/register", { method: "POST", body: form });
  if (!result.success) {
    throw new FaceServiceError(result.message || "Face registration failed", {
      errorCode: result.error_code || "FACE_NOT_DETECTED",
    });
  }
  return result;
}

/**
 * @param {Buffer} imageBuffer
 * @param {number[]} embedding
 */
export async function verifyFaceEmbedding(imageBuffer, embedding) {
  const form = new FormData();
  form.append("image", new Blob([imageBuffer], { type: "image/jpeg" }), "selfie.jpg");
  form.append("registered_embedding", JSON.stringify(embedding));

  const result = await faceServiceFetch("/face/verify", { method: "POST", body: form });
  return {
    matched: !!result.matched,
    similarityScore: result.similarity_score ?? 0,
    qualityScore: result.quality_score ?? 0,
    livenessPassed: result.liveness_passed ?? false,
    errorCode: result.error_code || null,
    message: result.message || null,
    threshold: getMatchThreshold(),
  };
}

/**
 * @param {Buffer[]} imageBuffers
 * @param {{ employee_id: string, embedding: number[] }[]} existingEmbeddings
 */
export async function checkDuplicateFace(imageBuffers, existingEmbeddings) {
  const form = new FormData();
  form.append("existing_embeddings", JSON.stringify(existingEmbeddings));
  for (const buf of imageBuffers) {
    form.append("images", new Blob([buf], { type: "image/jpeg" }), "frame.jpg");
  }

  const result = await faceServiceFetch("/face/check-duplicate", { method: "POST", body: form });
  return result;
}

/**
 * Match a probe image against all registered employee embeddings (kiosk identify).
 * @param {Buffer} imageBuffer
 * @param {{ employee_id: string, embedding: number[] }[]} existingEmbeddings
 */
export async function identifyFaceAmongProfiles(imageBuffer, existingEmbeddings) {
  const form = new FormData();
  form.append("existing_embeddings", JSON.stringify(existingEmbeddings));
  form.append("image", new Blob([imageBuffer], { type: "image/jpeg" }), "probe.jpg");

  const result = await faceServiceFetch("/face/identify", { method: "POST", body: form });
  return {
    matched: !!result.matched,
    employeeId: result.matched_employee_id || null,
    similarityScore: result.similarity_score ?? 0,
    qualityScore: result.quality_score ?? 0,
    errorCode: result.error_code || null,
    message: result.message || null,
    threshold: getMatchThreshold(),
  };
}

export async function checkFaceServiceHealth() {
  try {
    const response = await fetch(`${getServiceUrl()}/health`, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) return { ok: false };
    const data = await response.json();
    return { ok: data.status === "ok", modelLoaded: data.model_loaded };
  } catch {
    return { ok: false };
  }
}

export { getMatchThreshold, getDuplicateThreshold };

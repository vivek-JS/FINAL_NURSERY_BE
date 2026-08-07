import test from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { prepareFaceImage, getFaceDetectMaxDimension } from "../utility/faceImagePrep.js";
import { assessImageQuality, assessFaceDistance } from "../utility/imageQuality.js";
import { resolveEventTime, toIstYmd } from "../utility/attendanceEventTime.js";

/** Noisy mid-grey image — passes the brightness and sharpness heuristics. */
async function makeUsableJpeg(width, height) {
  const channels = 3;
  const data = Buffer.alloc(width * height * channels);
  for (let i = 0; i < data.length; i += 1) {
    data[i] = 90 + ((i * 37) % 120); // deterministic high-frequency texture
  }
  return sharp(data, { raw: { width, height, channels } }).jpeg({ quality: 95 }).toBuffer();
}

test("prepareFaceImage downscales oversized uploads while preserving aspect ratio", async () => {
  const max = getFaceDetectMaxDimension();
  const buffer = await makeUsableJpeg(1200, 1600);

  const prepared = await prepareFaceImage(buffer);

  assert.equal(prepared.channels, 3);
  assert.equal(Math.max(prepared.width, prepared.height), max);
  assert.equal(prepared.height, max);
  assert.equal(prepared.width, Math.round((1200 / 1600) * max));
  assert.equal(prepared.data.length, prepared.width * prepared.height * 3);
});

test("prepareFaceImage never enlarges a small image", async () => {
  const buffer = await makeUsableJpeg(320, 320);
  const prepared = await prepareFaceImage(buffer);
  assert.equal(prepared.width, 320);
  assert.equal(prepared.height, 320);
});

test("assessImageQuality returns the prepared image so callers can share one decode", async () => {
  const buffer = await makeUsableJpeg(1000, 1000);
  const quality = await assessImageQuality(buffer);

  assert.equal(quality.ok, true, `expected usable image, got ${quality.reason}`);
  assert.ok(quality.prepared, "prepared image should be returned for reuse");
  assert.equal(quality.prepared.width, getFaceDetectMaxDimension());
});

test("assessImageQuality still rejects tiny, dark and blurry uploads", async () => {
  const tiny = await makeUsableJpeg(200, 200);
  assert.equal((await assessImageQuality(tiny)).reason, "IMAGE_TOO_SMALL");

  const dark = await sharp({ create: { width: 600, height: 600, channels: 3, background: { r: 5, g: 5, b: 5 } } })
    .jpeg()
    .toBuffer();
  assert.equal((await assessImageQuality(dark)).reason, "POOR_LIGHTING_TOO_DARK");

  const flat = await sharp({ create: { width: 600, height: 600, channels: 3, background: { r: 128, g: 128, b: 128 } } })
    .jpeg()
    .toBuffer();
  assert.equal((await assessImageQuality(flat)).reason, "IMAGE_TOO_BLURRY");
});

test("assessImageQuality accepts an already-prepared image without re-decoding", async () => {
  const prepared = await prepareFaceImage(await makeUsableJpeg(900, 900));
  const quality = await assessImageQuality(prepared);
  assert.equal(quality.ok, true);
  assert.equal(quality.prepared, prepared, "should reuse the same object, not decode again");
});

test("framing math uses the prepared dimensions, not the original upload size", async () => {
  // A face box measured on the downscaled image against the ORIGINAL dimensions
  // would report a tiny area ratio and falsely trip FACE_TOO_FAR.
  const prepared = await prepareFaceImage(await makeUsableJpeg(3000, 4000));
  const box = { width: prepared.width * 0.5, height: prepared.height * 0.5 };

  assert.equal(assessFaceDistance(box, prepared.width, prepared.height).ok, true);
  assert.equal(assessFaceDistance(box, 3000, 4000).reason, "FACE_TOO_FAR");
});

test("resolveEventTime trusts recent capturedAt and rejects stale or future values", () => {
  const now = new Date("2026-07-30T12:00:00.000Z");

  const captured = new Date("2026-07-30T03:45:00.000Z");
  assert.deepEqual(resolveEventTime(captured.toISOString(), now), { time: captured, usedCapturedAt: true });

  assert.equal(resolveEventTime(undefined, now).time, now);
  assert.equal(resolveEventTime("not-a-date", now).time, now);
  assert.equal(resolveEventTime("2026-07-30T18:00:00.000Z", now).time, now, "future timestamps fall back to now");
  assert.equal(resolveEventTime("2026-07-01T09:00:00.000Z", now).time, now, "stale queues fall back to now");
});

test("toIstYmd rolls over on the IST day boundary, not UTC midnight", () => {
  assert.equal(toIstYmd(new Date("2026-07-29T18:29:00.000Z")), "2026-07-29");
  assert.equal(toIstYmd(new Date("2026-07-29T18:30:00.000Z")), "2026-07-30");
});

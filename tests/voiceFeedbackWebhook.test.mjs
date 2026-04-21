import test from "node:test";
import assert from "node:assert/strict";

function normalizeExotelPayload(body) {
  const b = body && typeof body === "object" ? body : {};
  const callSid =
    b.CallSid ||
    b.Sid ||
    b.Call?.Sid ||
    b.call_sid ||
    null;
  const callStatus = (
    b.CallStatus ||
    b.Status ||
    b.Call?.Status ||
    b.call_status ||
    ""
  )
    .toString()
    .toLowerCase();
  const recordingUrl =
    b.RecordingUrl || b.RecordingSid || b.recording_url || b.recordingUrl || null;
  const duration = Number(b.DialCallDuration || b.CallDuration || b.Duration || b.duration || 0);
  return { callSid, callStatus, recordingUrl, duration };
}

test("normalizeExotelPayload maps common Exotel JSON fields", () => {
  const a = normalizeExotelPayload({
    CallSid: "abc",
    CallStatus: "completed",
    RecordingUrl: "https://exotel.example/rec.mp3",
    DialCallDuration: "42",
  });
  assert.equal(a.callSid, "abc");
  assert.equal(a.callStatus, "completed");
  assert.equal(a.recordingUrl, "https://exotel.example/rec.mp3");
  assert.equal(a.duration, 42);
});

test("normalizeExotelPayload handles nested Call object", () => {
  const a = normalizeExotelPayload({
    Call: { Sid: "nested", Status: "answered" },
  });
  assert.equal(a.callSid, "nested");
  assert.equal(a.callStatus, "answered");
});

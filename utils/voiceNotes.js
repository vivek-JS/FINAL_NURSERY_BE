/**
 * Normalizes voice-note remarks sent by the Ram Orders app (JSON string from multipart or an array).
 * Only http(s) / local `/uploads/` audio URLs are kept; recorder fields come from the logged-in user.
 */
export function sanitizeVoiceNotes(raw, user, source = "BOOKING") {
  let list = raw;
  if (typeof list === "string") {
    try {
      list = JSON.parse(list);
    } catch {
      return [];
    }
  }
  if (list && !Array.isArray(list) && typeof list === "object") list = [list];
  if (!Array.isArray(list)) return [];
  return list
    .map((v) => ({
      url: String(v?.url || "").trim(),
      durationSec: Math.max(0, Math.round(Number(v?.durationSec) || 0)),
      note: String(v?.note || "").trim().slice(0, 500),
      recordedBy: user?._id || null,
      recordedByName: user?.name || "",
      recordedAt: new Date(),
      source,
    }))
    .filter((v) => /^https?:\/\//i.test(v.url) || v.url.startsWith("/uploads/"))
    .slice(0, 10);
}

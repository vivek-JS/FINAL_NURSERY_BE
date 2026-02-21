import { cleanAndValidateMobileNumber } from "../controllers/excel.serveces.controller.js";

export function dedupeCandidates(candidates = [], countryCode = "91") {
  const map = new Map();
  let duplicatesCount = 0;
  for (const candidate of candidates) {
    const rawPhone = candidate.phone || candidate.mobile || candidate.phoneNumber || "";
    const cleaned = cleanAndValidateMobileNumber(String(rawPhone || ""));
    if (!cleaned.primaryNumber) continue;
    const normalized = `${countryCode}${String(cleaned.primaryNumber).padStart(10, "0")}`;
    if (!map.has(normalized)) {
      map.set(normalized, {
        name: candidate.name || null,
        phone: normalized,
        farmerId: candidate.farmerId || null,
        message: candidate.message || "",
        status: "pending",
        normalizedPhone: normalized,
        attempts: 0,
      });
    } else {
      duplicatesCount++;
    }
  }
  return { finalTargets: Array.from(map.values()), duplicatesCount };
}


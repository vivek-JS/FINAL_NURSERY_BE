/**
 * Farmer lookup + mobile parsing for WhatsApp order bot.
 */

import Farmer from "../models/farmer.model.js";

export function normalizeWhatsAppMobile(input) {
  const digits = String(input ?? "").replace(/\D/g, "");
  if (digits.length === 10) return digits;
  if (digits.length === 12 && digits.startsWith("91")) return digits.slice(2);
  if (digits.length > 10) return digits.slice(-10);
  return null;
}

/** Extract first Indian mobile from free text. */
export function extractMobileFromMessage(text) {
  const raw = String(text ?? "");
  const match = raw.match(/(?:\+?91[\s-]*)?[6-9]\d{9}/);
  if (!match) return null;
  return normalizeWhatsAppMobile(match[0]);
}

export function isTenDigitMobileMessage(text) {
  const norm = normalizeWhatsAppMobile(text);
  return norm != null && String(text).replace(/\D/g, "").length >= 10;
}

export async function lookupFarmerByMobile(mobile) {
  const norm = normalizeWhatsAppMobile(mobile);
  if (!norm) return null;

  const asNum = Number(norm);
  if (!Number.isFinite(asNum)) return null;

  const farmer = await Farmer.findOne({ mobileNumber: asNum }).lean();
  if (!farmer) return null;

  return {
    id: String(farmer._id),
    name: farmer.name || "",
    mobileNumber: norm,
    village: farmer.village || "",
    taluka: farmer.talukaName || farmer.taluka || "",
    district: farmer.districtName || farmer.district || "",
    state: farmer.stateName || farmer.state || "Maharashtra",
    stateName: farmer.stateName || farmer.state || "Maharashtra",
    talukaName: farmer.talukaName || farmer.taluka || "",
    districtName: farmer.districtName || farmer.district || "",
    isNew: false,
  };
}

export function formatFarmerProfileMessage(farmer, { title = "✅ ग्राहक सापडला" } = {}) {
  const lines = [
    title,
    "",
    `👤 नाव: ${farmer.name || "—"}`,
    `📱 मोबाईल: ${farmer.mobileNumber || "—"}`,
    `🏘️ गाव: ${farmer.village || "—"}`,
    `📍 तालुका: ${farmer.talukaName || farmer.taluka || "—"}`,
    `📍 जिल्हा: ${farmer.districtName || farmer.district || "—"}`,
    `📍 राज्य: ${farmer.stateName || farmer.state || "Maharashtra"}`,
    "",
    "पुढे जायचे?",
    "1️⃣ होय — ऑर्डर सुरू करा",
    "2️⃣ नाही — दुसरा मोबाईल नंबर",
    "0️⃣ रद्द",
  ];
  return lines.join("\n");
}

export function emptyFarmerState() {
  return {
    id: null,
    name: "",
    mobileNumber: "",
    village: "",
    taluka: "",
    talukaName: "",
    district: "",
    districtName: "",
    state: "Maharashtra",
    stateName: "Maharashtra",
    isNew: false,
  };
}

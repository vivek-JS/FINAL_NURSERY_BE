/**
 * WATI templates use separate {{plant}} and {{subtype}} placeholders.
 * For numbered varieties like "15 no", merge into one phrase, e.g. "Papaya plant no 15",
 * and pass a neutral subtype so "15 no" never appears in the message body.
 */

import { formatWhatsAppPlantSubtypeLabel } from "../utils/whatsAppPlantSubtypeLabel.js";

/** Sent when variety is merged into `plantParam` so WATI body does not repeat "15 no". */
export const WATI_MERGED_SUBTYPE_PLACEHOLDER = "\u2014";

/** e.g. "15 no", "15no", "12 No." */
export function isNumberNoVarietyName(s) {
  const t = String(s ?? "").trim();
  if (!t) return false;
  return /^\d+\s*no\.?$/i.test(t) || /^\d+no\.?$/i.test(t);
}

/**
 * @param {string|null|undefined} plantNameRaw — CMS plant name, e.g. "Papaya"
 * @param {string|null|undefined} subtypeRaw — Subtype name, e.g. "15 no"
 * @returns {{ plantParam: string, subtypeParam: string }}
 */
export function watiPlantAndSubtypeParams(plantNameRaw, subtypeRaw) {
  const plant = String(plantNameRaw ?? "").trim() || "Plants";
  const sub = String(subtypeRaw ?? "").trim();
  if (!sub || sub === "N/A" || sub === "Unknown") {
    return { plantParam: plant, subtypeParam: "N/A" };
  }

  if (!isNumberNoVarietyName(sub)) {
    return { plantParam: plant, subtypeParam: sub };
  }

  const plantLower = plant.toLowerCase();
  const subLower = sub.toLowerCase();
  const alreadyHasSubtype =
    plantLower.includes(subLower) || plantLower.includes(`plant no ${subLower}`);

  if (alreadyHasSubtype) {
    return { plantParam: plant, subtypeParam: WATI_MERGED_SUBTYPE_PLACEHOLDER };
  }

  return {
    plantParam: formatWhatsAppPlantSubtypeLabel(plant, sub),
    subtypeParam: WATI_MERGED_SUBTYPE_PLACEHOLDER,
  };
}

/** Accept / collection WATI is sent for Banana (केळी) orders. */
export function isBananaPlantName(plantNameRaw, subtypeRaw = "") {
  return /banana|keli|केळ/i.test(`${plantNameRaw ?? ""} ${subtypeRaw ?? ""}`);
}

/** Papaya accepted-message templates intentionally use merged subtype text. */
export function isPapayaPlantName(plantNameRaw, subtypeRaw = "") {
  return /papaya/i.test(`${plantNameRaw ?? ""} ${subtypeRaw ?? ""}`);
}

export function isAcceptedWhatsAppPlantName(plantNameRaw, subtypeRaw = "") {
  return (
    isBananaPlantName(plantNameRaw, subtypeRaw) ||
    isPapayaPlantName(plantNameRaw, subtypeRaw)
  );
}

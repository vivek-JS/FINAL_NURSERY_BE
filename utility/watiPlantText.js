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

/** Accept / collection WATI is sent only for Banana (केळी) orders. */
export function isBananaPlantName(plantNameRaw, subtypeRaw = "") {
  return /banana|keli|केळ/i.test(`${plantNameRaw ?? ""} ${subtypeRaw ?? ""}`);
}

/** Farmer-facing short plant name for WhatsApp (Marathi where common). */
const WHATSAPP_PLANT_MARATHI_SHORT = {
  banana: "केळी",
  keli: "केळी",
  केळ: "केळी",
  केळी: "केळी",
  papaya: "Papaya",
  watermelon: "Tarbuj",
  tarbuj: "Tarbuj",
};

/**
 * CMS plant name → farmer WhatsApp label (e.g. Banana → केळी).
 * @param {string|null|undefined} plantNameRaw
 */
export function formatWhatsappPlantMarathiShort(plantNameRaw) {
  const plant = String(plantNameRaw ?? "").trim() || "Plants";
  const plantLower = plant.toLowerCase();
  for (const [key, label] of Object.entries(WHATSAPP_PLANT_MARATHI_SHORT)) {
    if (plantLower.includes(key.toLowerCase())) {
      return label;
    }
  }
  return plant;
}

/**
 * plantSubtype on Order is an ObjectId of an embedded PlantCms subtype — not populate()-able.
 * @param {{ subtypes?: Array<{ _id?: unknown, name?: string }> }|null|undefined} plantDoc
 * @param {unknown} plantSubtypeId
 */
export function resolveEmbeddedSubtypeName(plantDoc, plantSubtypeId) {
  if (!plantDoc || plantSubtypeId == null) return "";
  const sid = String(plantSubtypeId);
  const hit = (plantDoc.subtypes || []).find((s) => String(s._id) === sid);
  return hit?.name ? String(hit.name).trim() : "";
}

/**
 * Farmer-facing plant line when a single combined field is needed (not delivery_final_second).
 * delivery_final_second uses separate {{2}} plant + {{3}} subtype in WATI.
 */
export function formatWhatsappPlantSubtypeDisplay(plantNameRaw, subtypeRaw) {
  const displayPlant = formatWhatsappPlantMarathiShort(plantNameRaw);
  const sub = String(subtypeRaw ?? "").trim();

  if (!sub || sub === "N/A" || sub === "Unknown" || sub === "\u2014") {
    return displayPlant;
  }

  if (isNumberNoVarietyName(sub)) {
    return formatWhatsAppPlantSubtypeLabel(plantNameRaw, sub);
  }

  return `${displayPlant} - ${sub}`;
}

/**
 * {{2}} plant + {{3}} subtype for delivery_final_second.
 * @returns {{ plant: string, subtype: string }}
 */
export function deliveryFinalSecondPlantSubtypeParams(plantNameRaw, subtypeRaw) {
  const plant = formatWhatsappPlantMarathiShort(plantNameRaw);
  const sub = String(subtypeRaw ?? "").trim();
  if (!sub || sub === "N/A" || sub === "Unknown" || sub === WATI_MERGED_SUBTYPE_PLACEHOLDER) {
    return { plant, subtype: "" };
  }
  if (isNumberNoVarietyName(sub)) {
    return { plant, subtype: sub };
  }
  return { plant, subtype: sub };
}

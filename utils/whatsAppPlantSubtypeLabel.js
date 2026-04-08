/**
 * WhatsApp / WATI: map internal variety codes like "15 no" to a farmer-friendly label.
 * Raw "15 no" must not appear in messages — use "Papaya plant no 15" instead.
 * @param {string} [_plantTypeName] reserved for future plant-specific rules
 * @param {string} rawSubtype subtype name from DB / CMS
 * @returns {string}
 */
export function formatWhatsAppPlantSubtypeLabel(_plantTypeName, rawSubtype) {
  const raw = String(rawSubtype ?? "").trim();
  if (!raw || raw === "N/A") return raw || "N/A";
  if (/papaya\s+plant\s+no\s+\d+/i.test(raw)) return raw;

  const compact = raw.replace(/\s+/g, " ").trim();
  let m = compact.match(/^(\d+)\s*no\.?$/i);
  if (m) return `Papaya plant no ${m[1]}`;
  m = compact.match(/^no\.?\s*(\d+)$/i);
  if (m) return `Papaya plant no ${m[1]}`;
  return raw;
}

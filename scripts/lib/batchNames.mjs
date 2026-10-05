/**
 * Canonical batch names (from the owner's list). Every name must exist exactly once in the system.
 *
 *   RB 1811  RB 312  RB 510  RB 19  RB 38  RB Mix
 *   SB 208  SB 249  SB 318  SB 179  SB 178  SB 128  SB 278  SB Old  SB Mix
 *   VS 911  VS 912  VS 278
 *   CB Mix
 *
 * SB 307, SB 68 and SB 98 are to be considered "SB Old" (owner's note on the list).
 */
export const CANONICAL = [
  "RB 1811", "RB 312", "RB 510", "RB 19", "RB 38", "RB Mix", "RB 17",
  "SB 208", "SB 249", "SB 318", "SB 179", "SB 178", "SB 128", "SB 278", "SB 139", "SB Old", "SB Mix",
  "VS 911", "VS 912", "VS 278",
  "CB Mix",
];

const EXACT = {
  RB_1811: "RB 1811",
  "312": "RB 312",
  "510": "RB 510",
  "SB 208": "SB 208",
  SB_249: "SB 249",
  SB_318: "SB 318",
  SB_179: "SB 179",
  SB178: "SB 178",
  "SB-128": "SB 128",
  "SB-278": "SB 278",
  "SB-307": "SB Old",
  "SB-68": "SB Old",
  "SB-98": "SB Old",
  "VAS-D-RAIGAD-911": "VS 911",
  "VAS-D-SINHAGAD-278": "VS 278",
  "VAS-D-SINHAGAD-912": "VS 912",
  "SB-D-23NO-CB": "CB Mix",
  // judgement calls – flagged in the report
  "SB-D-12NOVISH-mix": "SB Mix",
  "SB-D-PURANDAR-mix-junerope": "RB Mix",
};

/** mappings that are my reading, not obvious from the list */
export const ASSUMED = new Set(["SB-D-12NOVISH-mix", "SB-D-PURANDAR-mix-junerope", "SB-307", "SB-68", "SB-98"]);

/** @returns {string|null} canonical name, or null when the batch is not in the owner's list */
export function canonicalName(batchNumber) {
  const s = String(batchNumber ?? "").trim();
  if (CANONICAL.includes(s)) return s; // already renamed
  if (EXACT[s]) return EXACT[s];
  const m = s.match(/^SB-D-[A-Z0-9]+-(.+)$/i);
  if (m) {
    const suffix = m[1];
    if (/^19$/.test(suffix)) return "RB 19";
    if (/^38$/.test(suffix)) return "RB 38";
    if (/^510$/.test(suffix)) return "RB 510";
    if (/^SB-OLD$/i.test(suffix)) return "SB Old";
  }
  return null;
}

/** Batch master template: Vasai (VS) vs everything else (G9) */
export const isVasai = (name) => /^VS /.test(name);

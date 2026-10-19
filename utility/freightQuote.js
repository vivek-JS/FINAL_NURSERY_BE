/**
 * Server-side freight quote. Mirrors quoteFreight in
 * nursery-mgmt/src/pages/private/cms/freightRates/freightRate.utils.js — keep both in sync.
 */

const round2 = (n) => Math.round(Number(n) * 100) / 100;

const norm = (s) => String(s || "").trim().toLowerCase();
const sameName = (a, b) => norm(a) === norm(b);

/** Plant names like "Banana G9" or "Papaya Red Lady" still match the "Banana"/"Papaya" slab crop. */
export function cropMatches(slabCrop, crop) {
  const a = norm(slabCrop);
  const b = norm(crop);
  if (!a || !b) return false;
  return a === b || b.startsWith(`${a} `) || b.includes(a);
}

export function slabMatches(slab, crates) {
  const c = Number(crates);
  if (!Number.isFinite(c)) return false;
  switch (slab?.condition) {
    case "BELOW":
      return c < Number(slab.value);
    case "ABOVE":
      return c > Number(slab.value);
    case "AT_LEAST":
      return c >= Number(slab.value);
    case "BETWEEN":
      return c >= Number(slab.from) && c <= Number(slab.to);
    default:
      return false;
  }
}

function slabLowerBound(slab) {
  switch (slab?.condition) {
    case "BELOW":
      return -Infinity;
    case "ABOVE":
      return Number(slab.value) + 0.5;
    case "AT_LEAST":
      return Number(slab.value);
    case "BETWEEN":
      return Number(slab.from);
    default:
      return 0;
  }
}

function slabUpperBound(slab) {
  switch (slab?.condition) {
    case "BELOW":
      return Number(slab.value) - 0.5;
    case "ABOVE":
    case "AT_LEAST":
      return Infinity;
    case "BETWEEN":
      return Number(slab.to);
    default:
      return 0;
  }
}

export function slabLabel(slab) {
  if (!slab) return "";
  switch (slab.condition) {
    case "BELOW":
      return `Below ${slab.value}`;
    case "ABOVE":
      return `Above ${slab.value}`;
    case "AT_LEAST":
      return `${slab.value}+`;
    case "BETWEEN":
      return `${slab.from}–${slab.to}`;
    default:
      return "";
  }
}

/**
 * @returns {{ ok: boolean, message: string, mode?: string, ratePerKm?: number, amount?: number|null, slab?: object, inGap?: boolean }}
 */
export function quoteFreight(card, { loadTypeName, crop, crates, km } = {}) {
  if (!card) return { ok: false, message: "Select a vehicle rate card" };
  const kmNum = Number(km);
  const hasKm = Number.isFinite(kmNum) && kmNum > 0;

  const shortKm = card.shortTripMaxKm;
  if (shortKm != null && card.shortTripRatePerKm != null && hasKm && kmNum < Number(shortKm)) {
    const ratePerKm = Number(card.shortTripRatePerKm);
    return {
      ok: true,
      mode: "SHORT_TRIP",
      ratePerKm,
      amount: round2(kmNum * ratePerKm),
      message: `Below ${shortKm} km — flat ₹${ratePerKm}/km`,
    };
  }

  const loadTypes = card.loadTypes || [];
  const loadType = loadTypes.find((l) => sameName(l.name, loadTypeName)) || loadTypes[0];
  if (!loadType) return { ok: false, message: "This rate card has no load types" };
  if (!crop) return { ok: false, message: "Select a crop" };
  const slabs = (loadType.slabs || [])
    .filter((s) => cropMatches(s.crop, crop))
    .sort((a, b) => slabLowerBound(a) - slabLowerBound(b));
  if (!slabs.length) return { ok: false, message: `No ${crop} rates in ${card.name} · ${loadType.name}` };

  const c = Number(crates);
  if (!Number.isFinite(c) || c <= 0) return { ok: false, message: "Enter number of crates" };

  let slab = slabs.find((s) => slabMatches(s, c));
  let inGap = false;
  if (!slab) {
    const lower = slabs.filter((s) => slabUpperBound(s) < c);
    if (!lower.length) {
      return { ok: false, message: `No rate for ${c} crates (rates start at ${slabLabel(slabs[0])})` };
    }
    slab = lower.reduce((best, s) => (slabUpperBound(s) > slabUpperBound(best) ? s : best));
    inGap = true;
  }
  const ratePerKm = Number(slab.ratePerKm);
  return {
    ok: true,
    mode: "SLAB",
    loadTypeName: loadType.name,
    slab,
    inGap,
    ratePerKm,
    amount: hasKm ? round2(kmNum * ratePerKm) : null,
    message: inGap
      ? `${c} crates is between slabs — using lower slab (${slabLabel(slab)})`
      : `${slabLabel(slab)} crates`,
  };
}

/** Crop with the most crates, plus total crates across the load. */
export function dominantCrop(loadSummary = []) {
  let best = null;
  let totalCrates = 0;
  for (const row of loadSummary) {
    const crates = Number(row?.crates) || 0;
    totalCrates += crates;
    if (!best || crates > (Number(best.crates) || 0)) best = row;
  }
  return { crop: best?.crop || "", totalCrates };
}

export { round2 };

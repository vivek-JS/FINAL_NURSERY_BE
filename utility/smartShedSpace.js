/**
 * Shared-floor capacity for the four sowing forts.
 * Papaya has its own ceiling. Watermelon and muskmelon share the melon ceiling.
 * A full papaya shed has no room left for watermelon.
 */

export const SMART_SHEDS = [
  {
    key: "panhalgad",
    label: "Panhalgad",
    labelMr: "पन्हाळगड",
    number: "12",
    papaya: 1820000,
    melon: 4045500,
    names: ["panhalgad", "panhala", "पन्हाळगड", "पन्हाळा"],
  },
  {
    key: "kondhana",
    label: "Kondhana",
    labelMr: "कोंढाणा",
    number: "23",
    papaya: 1140000,
    melon: 2394000,
    names: ["kondhana", "kondana", "कोंढाणा", "कोंडाणा"],
  },
  {
    key: "vishalgad",
    label: "Vishalgad",
    labelMr: "विशालगड",
    number: "14",
    papaya: 300000,
    melon: 630000,
    names: ["vishalgad", "vishalgadh", "विशाळगड", "विशालगड", "विशाल गड", "विशाळ गड"],
  },
  {
    key: "salher",
    label: "Salher",
    labelMr: "साल्हेर",
    number: "15",
    papaya: 282000,
    melon: 592000,
    names: ["salher", "salheri", "साल्हेर"],
  },
];

const OUT_STATUSES = new Set(["DISPATCHED", "COMPLETED"]);

const fold = (value) => String(value || "").toLowerCase().replace(/\s+/g, "");

export function isOrderOut(status) {
  return OUT_STATUSES.has(String(status || "").toUpperCase());
}

/** papaya | watermelon | muskmelon | null. Muskmelon is checked before watermelon. */
export function cropOf(name) {
  const text = String(name || "");
  const s = text.toLowerCase();
  if (/papaya|pappaya|papai/.test(s) || text.includes("पपई")) return "papaya";
  if (/musk|kharbuj/.test(s) || text.includes("खरबूज")) return "muskmelon";
  if (/water|tarbuj/.test(s) || text.includes("टरबूज") || text.includes("टरबुज") || text.includes("कलिंगड")) {
    return "watermelon";
  }
  return null;
}

export function poolOf(crop) {
  if (crop === "papaya") return "papaya";
  if (crop === "watermelon" || crop === "muskmelon") return "melon";
  return null;
}

/**
 * Fort named in the text wins. A bare shade number is used only when no fort name is present.
 * Two different fort names is unmatched (null).
 */
export function fortFromText(text) {
  const raw = String(text || "");
  const folded = fold(raw);
  const named = SMART_SHEDS.filter((fort) => fort.names.some((name) => folded.includes(fold(name))));
  if (named.length === 1) return named[0];
  if (named.length > 1) return null;
  const numbered = SMART_SHEDS.filter((fort) => new RegExp(`(?:^|[^0-9])${fort.number}(?:[^0-9]|$)`).test(raw));
  if (numbered.length === 1) return numbered[0];
  return null;
}

/** Shade master row → fort. Name inside the shade title wins over the shade number. */
export function fortForShade(shade) {
  const named = fortFromText(shade?.name || "");
  if (named) return named;
  const number = String(shade?.number ?? "").trim();
  return SMART_SHEDS.find((fort) => fort.number === number) || null;
}

/** Stored shade ceilings when set, otherwise the fort config. */
export function ceilingsFor(fort, shade) {
  const papaya = Number(shade?.smartCapacity?.papaya);
  const melon = Number(shade?.smartCapacity?.melon);
  return {
    papayaMax: papaya > 0 ? papaya : fort.papaya,
    melonMax: melon > 0 ? melon : fort.melon,
  };
}

/**
 * Shared floor. Room for papaya and room for watermelon are alternatives, not a sum.
 */
export function shedRoom({ papayaUsed = 0, melonUsed = 0, papayaMax = 0, melonMax = 0 } = {}) {
  const pMax = Number(papayaMax) || 0;
  const mMax = Number(melonMax) || 0;
  const pUsed = Math.max(0, Number(papayaUsed) || 0);
  const mUsed = Math.max(0, Number(melonUsed) || 0);
  const pFrac = pMax > 0 ? pUsed / pMax : pUsed > 0 ? Number.POSITIVE_INFINITY : 0;
  const mFrac = mMax > 0 ? mUsed / mMax : mUsed > 0 ? Number.POSITIVE_INFINITY : 0;
  const used = pFrac + mFrac;
  const vacant = Number.isFinite(used) ? Math.max(0, 1 - used) : 0;
  return {
    used,
    vacant,
    over: used > 1,
    papayaRoom: Math.floor(vacant * pMax),
    melonRoom: Math.floor(vacant * mMax),
  };
}

/** Cover lives on the destination batch after a move, otherwise on the source batch. */
export function coverBatchId(source) {
  if (!source) return "";
  if (source.moved && source.destBatchId) return String(source.destBatchId);
  if (source.batchId) return String(source.batchId);
  return "";
}

const idStr = (value) => (value == null || value === "" ? "" : String(value._id ?? value));

/**
 * Plants on one sowing batch that still hold shed space.
 * covers: [{ orderId, plants, out }] already limited to this batch.
 * Order-out releases that share once: the larger of the dispatch log and the status, not the sum.
 * Excess and the mortality buffer stay until they are loaded or destroyed.
 * Cancel is not out — pass those covers with out: false.
 */
export function batchSpaceHold(batch, covers = []) {
  if (!batch || batch.readyPlantsReceived === false) {
    return { occupied: 0, onOpen: 0, noOrder: 0, orderOut: 0, skipped: true };
  }
  const sowed = Math.max(0, Number(batch.plantsSowed) || 0);
  const destroyed = Math.max(0, Number(batch.destroyedPlants) || 0);
  let logNet = 0;
  const logByOrder = new Map();
  for (const row of batch.dispatchLog || []) {
    const plants = Number(row?.plants) || 0;
    logNet += plants;
    const id = idStr(row?.orderId);
    if (!id) continue;
    logByOrder.set(id, (logByOrder.get(id) || 0) + plants);
  }
  const physical = Math.max(0, sowed - destroyed - logNet);

  let outCover = 0;
  let openCover = 0;
  let logForOut = 0;
  let logForOpen = 0;
  const seen = new Set();
  for (const cover of covers) {
    const plants = Math.max(0, Number(cover?.plants) || 0);
    const id = idStr(cover?.orderId);
    const logged = id ? logByOrder.get(id) || 0 : 0;
    if (id && !seen.has(id)) {
      seen.add(id);
      if (cover?.out) logForOut += logged;
      else logForOpen += logged;
    }
    if (cover?.out) outCover += plants;
    else openCover += plants;
  }

  const statusExtra = Math.max(0, outCover - Math.max(0, logForOut));
  const occupied = Math.max(0, physical - statusExtra);
  const onOpen = Math.min(occupied, Math.max(0, openCover - Math.max(0, logForOpen)));
  const noOrder = Math.max(0, occupied - onOpen);
  return { occupied, onOpen, noOrder, orderOut: outCover, skipped: false };
}

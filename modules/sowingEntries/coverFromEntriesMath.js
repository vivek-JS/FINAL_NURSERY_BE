const int = (value) => Math.max(0, Math.floor(Number(value) || 0));

/** { entryId, plants } picks. A row without an entry id is ignored. */
export function normalizeEntryPicks(picks) {
  let list = picks;
  if (typeof list === "string") {
    try {
      list = JSON.parse(list);
    } catch {
      list = [];
    }
  }
  if (!Array.isArray(list)) return [];
  const byId = new Map();
  for (const pick of list) {
    const entryId = String(pick?.entryId || "").trim();
    const plants = int(pick?.plants);
    if (!entryId || plants < 1) continue;
    const prev = byId.get(entryId);
    if (prev) prev.plants += plants;
    else byId.set(entryId, { entryId, plants });
  }
  return [...byId.values()];
}

/**
 * Plants taken off each sowing entry.
 * Free excess is decremented. Plants this order already holds on the entry stay put.
 */
export function planEntryTakes(picks, rows) {
  const byId = new Map((rows || []).map((row) => [String(row.entryId), row]));
  return picks.map((pick) => {
    const row = byId.get(String(pick.entryId));
    if (!row) {
      const err = new Error("A selected sowing is no longer in this window");
      err.status = 409;
      err.code = "ENTRY_NOT_IN_WINDOW";
      throw err;
    }
    const plants = int(pick.plants);
    const free = int(row.freePlants);
    if (plants > free) {
      const err = new Error(
        `${row.requestNumber || "Sowing"} has only ${free} free plants now`
      );
      err.status = 409;
      err.code = "INSUFFICIENT_ENTRY_EXCESS";
      throw err;
    }
    const fromExcess = Math.min(plants, int(row.excessPlants));
    return { ...row, plants, fromExcess };
  });
}

export function picksMatchNeed(picks, need) {
  const qty = int(need);
  const sum = (picks || []).reduce((total, pick) => total + int(pick.plants), 0);
  return qty > 0 && sum === qty;
}

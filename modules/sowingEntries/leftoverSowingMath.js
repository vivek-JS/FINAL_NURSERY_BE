import { sowDayFrom } from "./mapSowingEntry.js";
import { excessFieldsForBatch } from "../../utility/sowingBatchExcessStamp.js";

const int = (value) => Math.max(0, Math.floor(Number(value) || 0));

function plain(entry) {
  return { ...(entry?.toObject ? entry.toObject() : entry) };
}

/** Mortality plants still held. A zero buffer with a percent uses that percent. */
export function heldBuffer(entry) {
  if (!entry || entry.noMortalityReserve) return 0;
  const stamped = int(entry.bufferPlants);
  if (stamped > 0) return stamped;
  const pct = Number(entry.sowingBufferPct) || 0;
  if (pct <= 0) return 0;
  return Math.round((int(entry.plantsSowed) * pct) / 100);
}

/** Recompute excess and remaining from the plants still on the sowing. */
export function restamp(entry) {
  const next = plain(entry);
  const destroyed = int(next.destroyedPlants);
  const net = Math.max(0, int(next.plantsSowed) - destroyed);
  const fields = excessFieldsForBatch({ ...next, plantsSowed: net }, next.sowingBufferPct || 0);
  if (next.noMortalityReserve) {
    next.bufferPlants = 0;
    next.sowingBufferPct = 0;
  } else {
    next.bufferPlants = fields.bufferPlants;
    next.sowingBufferPct = fields.sowingBufferPct;
  }
  next.excessPlants = fields.shownExcess;
  const mortality = next.noMortalityReserve ? 0 : fields.bufferPlants;
  next.remainingPlants = Math.max(0, net - mortality - int(next.dispatchedPlants));
  return next;
}

/**
 * Change plants sowed and keep the old mortality plant count.
 * When that buffer no longer fits the smaller sow, keep only the plants that still fit.
 */
export function withSowed(entry, plantsSowed) {
  const oldBuffer = heldBuffer(entry);
  const newSowed = Math.max(0, int(plantsSowed));
  const next = { ...plain(entry), plantsSowed: newSowed };
  if (oldBuffer <= 0 || newSowed <= 0) {
    next.noMortalityReserve = true;
    next.sowingBufferPct = 0;
    next.bufferPlants = 0;
  } else {
    const buffer = Math.min(oldBuffer, newSowed);
    next.noMortalityReserve = false;
    next.bufferPlants = buffer;
    next.sowingBufferPct = (buffer * 100) / newSowed;
  }
  return restamp(next);
}

/** Stamp leftover plants as extra bookable excess. Mortality and sowed stay. */
export function withMarked(entry, extra) {
  const next = {
    ...plain(entry),
    plantsMarkedSellable: int(entry?.plantsMarkedSellable) + int(extra),
  };
  return restamp(next);
}

export function readyKeyOf(entry) {
  return sowDayFrom(entry?.plantReadyDate) || "";
}

/** Next same-variety sowing: soonest ready date after this one, then soonest sow date. */
export function pickNextSowing(source, rows) {
  const sourceReady = readyKeyOf(source);
  if (!sourceReady) return null;
  const sourceId = String(source?._id || "");
  const next = (rows || [])
    .filter((row) => String(row?._id || "") !== sourceId && !row?.isIrrelevant)
    .map((row) => ({
      row,
      ready: readyKeyOf(row),
      sow: row.sowDay || sowDayFrom(row.sowingDate) || "",
    }))
    .filter((item) => item.ready && item.ready > sourceReady)
    .sort(
      (a, b) =>
        a.ready.localeCompare(b.ready) ||
        a.sow.localeCompare(b.sow) ||
        String(a.row._id).localeCompare(String(b.row._id))
    );
  return next[0]?.row || null;
}

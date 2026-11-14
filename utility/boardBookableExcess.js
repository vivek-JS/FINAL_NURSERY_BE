/**
 * Plants still free to sell on the capacity board.
 * Expected ready = sowed − CMS mortality. Then take off plants already given
 * and plants still to give (live sowing cover, not the stored stamp).
 * Old sowings are 0. A sowing that is over the hold reduces the other free
 * plants of that variety, so the total is what can still be booked.
 */

function qty(value) {
  return Math.max(0, Math.floor(Number(value) || 0));
}

export function signedBatchFree(batch, cmsPct = 0, coverByRequest = null, seenRequests = null) {
  if (!batch || batch.isIrrelevant) return 0;
  const sowed = Math.max(0, qty(batch.plantsSowed) - qty(batch.destroyedPlants));
  if (sowed < 1) return 0;
  const batchPct = Number(batch.sowingBufferPct);
  const noHold = Boolean(batch.noMortalityReserve) || batchPct === 0;
  const pct = noHold ? 0 : Math.max(0, Number(cmsPct) || 0);
  const hold = Math.round((sowed * pct) / 100);
  const requestNumber = String(batch.requestNumber || "");
  let orders;
  if (requestNumber && coverByRequest?.has(requestNumber)) {
    if (seenRequests?.has(requestNumber)) return 0;
    seenRequests?.add(requestNumber);
    orders = qty(coverByRequest.get(requestNumber));
  } else {
    orders = qty(batch.orderCoveredPlants);
  }
  const moved = qty(batch.mortalityMovedToExcess);
  const fromExcess = qty(batch.excessMovedToMortality);
  return sowed - hold - orders + moved - fromExcess;
}

/** slotId → plants that can still be booked. Negatives are taken off the earliest free slot. */
export function bookableExcessBySlot(slots, cmsPct = 0, coverByRequest = null) {
  const seen = new Set();
  const lines = (slots || []).map((slot) => {
    let signed = 0;
    let clamped = 0;
    for (const batch of slot?.sowingBatches || []) {
      const free = signedBatchFree(batch, cmsPct, coverByRequest, seen);
      signed += free;
      clamped += Math.max(0, free);
    }
    return {
      slotId: String(slot?.slotId || ""),
      start: String(slot?.slotStartDay || slot?.startDay || ""),
      clamped,
      signed,
    };
  });
  let debt =
    lines.reduce((sum, line) => sum + line.clamped, 0) -
    Math.max(0, lines.reduce((sum, line) => sum + line.signed, 0));
  const ordered = lines.slice().sort((a, b) => a.start.localeCompare(b.start) || a.slotId.localeCompare(b.slotId));
  const out = new Map();
  for (const line of ordered) {
    const take = Math.min(line.clamped, Math.max(0, debt));
    debt -= take;
    if (line.slotId) out.set(line.slotId, line.clamped - take);
  }
  return out;
}

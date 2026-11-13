/**
 * Cover story for one order against one sowing entry.
 * Maintained on the API so FE only displays these fields.
 *
 *   orderPlants  = booked qty
 *   sownHere     = plants from THIS sowing (capped at order)
 *   remaining    = still needed after this sow + other SRs (Also may fill → 0)
 *   stillNeed    = same as remaining (alias for drawer header)
 *   coverStatus  = done | partial | need
 *
 * Mortality buffer is NOT cover — callers must not unlock mortality into fromThis.
 */

const intQty = (v) => Math.max(0, Math.floor(Number(v) || 0));

export function orderPlantsNeed(orderLike) {
  return (
    intQty(orderLike?.plants) ||
    intQty(orderLike?.numberOfPlants) + intQty(orderLike?.additionalPlants) ||
    intQty(orderLike?.bookedPlants)
  );
}

/**
 * @param {object} input
 * @param {number} input.orderPlants
 * @param {number} input.fromThisRaw  plants attributed to this sowing (may exceed order)
 * @param {number} [input.fromOthers]
 * @param {number} [input.excessFromThisRaw]
 * @param {boolean} [input.sowingDone]
 * @param {string} [input.coverKind]
 * @param {Array<{requestNumber?: string, plants?: number, offsetDays?: number|null}>} [input.otherCoverSources]
 */
export function buildOrderSowingCoverBreakdown({
  orderPlants = 0,
  fromThisRaw = 0,
  fromOthers = 0,
  excessFromThisRaw = 0,
  sowingDone = false,
  coverKind = "fifo",
  otherCoverSources = [],
} = {}) {
  const booked = intQty(orderPlants);
  const rawHere = intQty(fromThisRaw);
  const others = intQty(fromOthers);
  const sownHere = booked > 0 ? Math.min(rawHere, booked) : rawHere;
  const coveredTowardOrder = Math.min(booked || sownHere + others, sownHere + others);
  /** Truly unsown after every SR — Also line explains split cover. */
  const remaining = Math.max(0, booked - coveredTowardOrder);
  const stillNeed = remaining;
  const excessFromThisSowing =
    booked > 0 ? Math.min(intQty(excessFromThisRaw), sownHere, booked) : intQty(excessFromThisRaw);

  // Covered when order is fully filled (this sow and/or Also).
  let coverStatus = "need";
  if (remaining < 1 && coveredTowardOrder > 0) coverStatus = "done";
  else if (sownHere > 0 && remaining > 0) coverStatus = "partial";
  else if (sownHere < 1 && remaining > 0) coverStatus = "need";

  const partial = coverStatus === "partial";
  const done = coverStatus === "done";
  const kind = String(coverKind || "fifo").toLowerCase();

  return {
    orderPlants: booked,
    sownHere,
    sownHereRaw: rawHere,
    fromOthers: others,
    remaining,
    stillNeed,
    coveredPlants: coveredTowardOrder,
    excessFromThisSowing,
    coverKind: kind,
    coverStatus,
    /** True when this entry + others finish the order. */
    sowingDone: done,
    /** Raw order flag — order may be marked done elsewhere with no plants on this sow. */
    orderSowingDone: Boolean(sowingDone),
    partiallyCovered: partial,
    otherCoverSources: (otherCoverSources || [])
      .map((s) => ({
        requestNumber: String(s?.requestNumber || s?.sowingRequestId || "other").trim() || "other",
        plants: intQty(s?.plants),
        offsetDays: s?.offsetDays ?? null,
      }))
      .filter((s) => s.plants > 0),
  };
}

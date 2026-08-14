/**
 * Allocate a unique trip number.
 * Prefer TRIP-R-{transportId} when completing a dispatch (stable, no null upserts).
 */
export async function allocateTripNumber(TripModel, { transportId } = {}) {
  const tid = transportId != null ? String(transportId).trim() : "";
  if (tid) {
    return `TRIP-R-${tid}`;
  }
  const count = await TripModel.countDocuments();
  const year = new Date().getFullYear();
  return `TRIP-${year}-${String(count + 1).padStart(4, "0")}`;
}

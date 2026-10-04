/**
 * Shared expiry sort for sowing issue fills.
 * FIFO / FEFO: nearest expiry first. Latest: farthest expiry first.
 * Batches without expiry always sort last.
 */

export function expiryMillis(value) {
  if (!value) return null;
  const t = new Date(value).getTime();
  return Number.isFinite(t) ? t : null;
}

export function compareByExpiry(a, b, latestFirst = false) {
  const aExp = expiryMillis(a?.expiryDate);
  const bExp = expiryMillis(b?.expiryDate);
  if (aExp == null && bExp == null) {
    const aRec = expiryMillis(a?.receivedDate || a?.createdAt) || 0;
    const bRec = expiryMillis(b?.receivedDate || b?.createdAt) || 0;
    if (aRec !== bRec) return latestFirst ? bRec - aRec : aRec - bRec;
    return String(a?.batchNumber || '').localeCompare(String(b?.batchNumber || ''));
  }
  if (aExp == null) return 1;
  if (bExp == null) return -1;
  if (aExp !== bExp) return latestFirst ? bExp - aExp : aExp - bExp;
  const aRec = expiryMillis(a?.receivedDate || a?.createdAt) || 0;
  const bRec = expiryMillis(b?.receivedDate || b?.createdAt) || 0;
  if (aRec !== bRec) return latestFirst ? bRec - aRec : aRec - bRec;
  return String(a?.batchNumber || '').localeCompare(String(b?.batchNumber || ''));
}

export function sortBatchesByExpiry(batches, fillMode = 'fifo') {
  const latestFirst = fillMode === 'latest';
  return [...(batches || [])].sort((a, b) => compareByExpiry(a, b, latestFirst));
}

export function fillBatchAllocations(
  batches,
  requestedQty,
  fillMode = 'fifo',
  getAvailable = (batch) => Number(batch?.remainingQuantity) || 0
) {
  const qty = Number(requestedQty) || 0;
  const allocations = {};
  if (qty <= 0) return allocations;
  let remaining = qty;
  for (const batch of sortBatchesByExpiry(batches, fillMode)) {
    if (remaining <= 0.01) break;
    const id = batch?._id;
    if (!id) continue;
    const available = Number(getAvailable(batch)) || 0;
    if (available <= 0) continue;
    const take = Math.min(remaining, available);
    if (take > 0.01) {
      allocations[String(id)] = parseFloat(take.toFixed(2));
      remaining -= take;
    }
  }
  return allocations;
}

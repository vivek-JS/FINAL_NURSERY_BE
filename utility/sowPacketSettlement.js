/**
 * Decide packets used vs returned for complete-sow.
 * User-entered return is honored even when plant/cf used-hint would consume every bag.
 */
export function settleSowPackets({
  remaining = 0,
  usedHint = 0,
  packetsToReturn = 0,
  completeSowing = false,
} = {}) {
  const rem = Math.max(0, Number(remaining) || 0);
  let ret = Math.max(0, Number(packetsToReturn) || 0);
  let used = Math.max(0, Number(usedHint) || 0);

  ret = Math.min(ret, rem);
  used = Math.min(used, Math.max(0, rem - ret));

  if (completeSowing) {
    ret = Math.max(ret, rem - used);
  }

  if (used + ret > rem) {
    ret = Math.max(0, rem - used);
  }

  return { packetsUsed: used, packetsToReturn: ret };
}

/** Request is closed when the worker marks complete, or no company bags remain. */
export function isSowingRequestClosed({
  completeSowing = false,
  remainingAfter = 0,
  companyPackets = 0,
  remainingSowingNeeded = 0,
} = {}) {
  if (completeSowing) return true;
  if ((Number(companyPackets) || 0) <= 0) {
    return (Number(remainingSowingNeeded) || 0) <= 0;
  }
  return (Number(remainingAfter) || 0) <= 0;
}

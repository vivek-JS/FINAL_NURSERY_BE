/** Shared collection risk bands for territory / branch analytics. */
export function collectionRisk(pct) {
  if (pct >= 85) return "excellent";
  if (pct >= 60) return "average";
  return "risk";
}

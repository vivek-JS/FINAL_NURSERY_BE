/** Plants expected from 1 primary unit packet — sowing math, not UOM conversionFactor. */
export function resolveSowingPlantsPerPacket(entity) {
  const tpp = Number(entity?.tentativePlantsPerPacket);
  if (Number.isFinite(tpp) && tpp > 0) return tpp;
  const cf = Number(entity?.conversionFactor);
  return Number.isFinite(cf) && cf > 0 ? cf : 1;
}

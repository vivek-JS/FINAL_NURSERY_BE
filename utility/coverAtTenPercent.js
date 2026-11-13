/** 10% of sowed is mortality. The rest is the cover pool. */
export function mortalityAtTenPercent(plantsSowed) {
  const sowed = Math.max(0, Math.floor(Number(plantsSowed) || 0));
  return Math.round((sowed * 10) / 100);
}

/**
 * Cover orders from the plants left after 10% mortality.
 * If that 10% is enough to finish the last short order, cover it completely.
 * If the gap is bigger than the 10%, the order stays partial.
 * quantities are in delivery order.
 */
export function coverAtTenPercent(plantsSowed, quantities = []) {
  const sowed = Math.max(0, Math.floor(Number(plantsSowed) || 0));
  const mortality = mortalityAtTenPercent(sowed);
  const pool = Math.max(0, sowed - mortality);
  let left = pool;
  let finishedFromMortality = false;
  const taken = [];

  for (const raw of quantities) {
    const need = Math.max(0, Math.floor(Number(raw) || 0));
    if (need < 1) {
      taken.push(0);
      continue;
    }
    if (left >= need) {
      taken.push(need);
      left -= need;
      continue;
    }
    const gap = need - left;
    if (left > 0 && !finishedFromMortality && gap <= mortality) {
      taken.push(need);
      left = 0;
      finishedFromMortality = true;
      continue;
    }
    if (left > 0 && !finishedFromMortality) {
      taken.push(left);
      left = 0;
      finishedFromMortality = true;
      continue;
    }
    taken.push(0);
  }

  const covered = taken.reduce((sum, n) => sum + n, 0);
  const mortalityUsed = Math.max(0, covered - pool);
  const mortalityLeft = Math.max(0, mortality - mortalityUsed);
  const excess = Math.max(0, sowed - mortalityLeft - covered);
  return { taken, covered, mortality, mortalityLeft, excess, pool };
}

const DISPATCH_DAY_KEY_TO_OFFSET = {
  TODAY: 0,
  TOMORROW: 1,
  DAY_AFTER: 2,
};

export const normalizeToDayStart = (dateObj) => {
  const d = new Date(dateObj);
  d.setHours(0, 0, 0, 0);
  return d;
};

export function getDispatchTargetDateFromKey(dispatchDayKey) {
  const offset = DISPATCH_DAY_KEY_TO_OFFSET[dispatchDayKey];
  if (offset === undefined) return null;
  const base = normalizeToDayStart(new Date());
  base.setDate(base.getDate() + offset);
  return base;
}

export { DISPATCH_DAY_KEY_TO_OFFSET };

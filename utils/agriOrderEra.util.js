/** End of 29 Jul 2026 IST — used by migration script only. */
export const AGRI_OLD_CUTOFF_END = new Date("2026-07-29T18:29:59.999Z");

/**
 * Mongo filter for Ram Agri order era.
 * @param {string|boolean|undefined} isOldParam - query param `isOld`
 * @returns {{ isOld: true } | { isOld: { $ne: true } }}
 */
export function resolveAgriOldFilter(isOldParam) {
  if (isOldParam === "true" || isOldParam === true) {
    return { isOld: true };
  }
  return { isOld: { $ne: true } };
}

/** Merge era filter into an existing Mongo query object. */
export function mergeAgriOldFilter(baseFilter, isOldParam) {
  return { ...baseFilter, ...resolveAgriOldFilter(isOldParam) };
}

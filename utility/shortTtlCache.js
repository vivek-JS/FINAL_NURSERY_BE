/**
 * Tiny in-process TTL cache for hot Ram Live / mobile GETs.
 * Keyed string → { at, value }. Not shared across PM2 workers.
 */
export function createShortTtlCache(ttlMs = 45_000) {
  const store = new Map();
  return {
    get(key) {
      const hit = store.get(String(key));
      if (!hit) return null;
      if (Date.now() - hit.at > ttlMs) {
        store.delete(String(key));
        return null;
      }
      return hit.value;
    },
    set(key, value) {
      store.set(String(key), { at: Date.now(), value });
      return value;
    },
    clear() {
      store.clear();
    },
  };
}

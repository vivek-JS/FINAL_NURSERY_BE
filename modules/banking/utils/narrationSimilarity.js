/**
 * Simple token-overlap similarity for bank narration vs payment reference text.
 * Returns 0..1 confidence contribution.
 */

function tokenize(str) {
  return String(str || "")
    .toUpperCase()
    .replace(/[^A-Z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 3);
}

export function narrationSimilarity(narration, referenceText) {
  const a = new Set(tokenize(narration));
  const b = new Set(tokenize(referenceText));
  if (!a.size || !b.size) return 0;

  let overlap = 0;
  for (const t of a) {
    if (b.has(t)) overlap += 1;
  }
  return overlap / Math.max(a.size, b.size);
}

export function containsUtrInNarration(narration, utr) {
  if (!utr) return false;
  const n = String(narration || "").toUpperCase().replace(/\s+/g, "");
  const u = String(utr).toUpperCase().replace(/\s+/g, "");
  return u.length >= 8 && n.includes(u);
}

/** Narrations banks print for cash paid in at a branch or a deposit machine. */
const CASH_CREDIT_RE = /\bCASH\b|\bCSH\b|CASH\s*DEP|BY\s*CASH|\bCDM\b|\bBNA\b|\bCSHDEP\b/i;

export function isCashCreditLine(entry) {
  return Number(entry?.amount) > 0 && CASH_CREDIT_RE.test(String(entry?.narration || ""));
}

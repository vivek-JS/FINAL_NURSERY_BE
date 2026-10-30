/**
 * Which orders and lagwad lines belong on one 5-day card.
 * The first card (includeOverdue) also keeps past-due orders inside the lookback
 * and lagwad that is already ready.
 */

export function orderInSlot(ymd, { from, to, includeOverdue, lookbackStart }) {
  if (!ymd) return Boolean(includeOverdue);
  if (ymd >= from && ymd <= to) return true;
  if (!includeOverdue || ymd > to || ymd >= from) return false;
  return !lookbackStart || ymd >= lookbackStart;
}

export function lagwadInSlot(ymd, { from, to, includeOverdue }) {
  if (!ymd) return Boolean(includeOverdue);
  if (ymd > to) return false;
  if (ymd >= from) return true;
  return Boolean(includeOverdue);
}

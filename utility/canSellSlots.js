/**
 * FIFO can-book / can-sell across date windows.
 * Later shortages lock earlier surplus (walk from the end).
 * Same rules as ram-live/src/lib/canSell.ts canSellSlots.
 */

const whole = (n) => Math.max(0, Math.round(Number(n) || 0));

/**
 * @param {Array<{ key: string, from: string, to: string, lagwad?: number, dispatch?: number, overdueDispatch?: number, oldLagwad?: number }>} windows
 */
export function canSellSlots(windows) {
  const slots = (windows || []).map((w) => {
    const available = whole(w.lagwad);
    const stillToGive = whole(w.dispatch);
    const ownFree = available - stillToGive;
    return {
      key: w.key,
      from: w.from,
      to: w.to,
      available,
      stillToGive,
      overdue: whole(w.overdueDispatch),
      ownFree,
      short: Math.max(0, -ownFree),
      reservedForLater: 0,
      canSell: Math.max(0, ownFree),
      oldPlants: whole(w.oldLagwad),
    };
  });

  let carry = 0;
  for (let i = slots.length - 1; i >= 0; i -= 1) {
    const slot = slots[i];
    if (slot.ownFree < 0) {
      carry += -slot.ownFree;
      slot.canSell = 0;
      slot.reservedForLater = 0;
      continue;
    }
    const reserved = Math.min(slot.ownFree, carry);
    slot.reservedForLater = reserved;
    slot.canSell = slot.ownFree - reserved;
    carry -= reserved;
  }
  return slots;
}

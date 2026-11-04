export const BOTTLES_PER_TRAY = 30;
export const SIZES = ["R1", "R2", "R3"];

export function traySplit(bottles) {
  const n = Math.max(0, Math.floor(Number(bottles) || 0));
  return {
    bottles: n,
    completeTrays: Math.floor(n / BOTTLES_PER_TRAY),
    incompleteBottles: n % BOTTLES_PER_TRAY,
  };
}

export function mortalityExpectedPlants(expectedPlants) {
  const n = Math.floor(Number(expectedPlants) || 0);
  if (n < 1) return 0;
  return Math.floor(n * 0.9);
}

export function plantsNotSent(mortality, sent) {
  return Math.max(0, Math.floor(Number(mortality) || 0) - Math.floor(Number(sent) || 0));
}

export function parseDay(input) {
  const text = String(input || "").slice(0, 10);
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!match) return null;
  return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
}

export function istToday() {
  const text = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  return parseDay(text);
}

export function addCalendarDays(day, days) {
  const next = new Date(day.getTime());
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

/**
 * Spend bottles of one size only. R1 is never taken from an R2 or R3 receipt.
 * Null when that size cannot cover the count.
 */
export function takeBottles(receipts, bottles, size) {
  const need = Math.floor(Number(bottles) || 0);
  if (need < 1 || !SIZES.includes(size)) return null;
  let left = need;
  const next = receipts.map((row) => ({ ...row }));
  for (const row of next) {
    if (left <= 0) break;
    if (row.size !== size) continue;
    const have = Math.max(0, Math.floor(Number(row.bottlesLeft) || 0));
    if (have < 1) continue;
    const take = Math.min(have, left);
    row.bottlesLeft = have - take;
    left -= take;
  }
  if (left > 0) return null;
  return { receipts: next, size };
}

export function normalizeSize(size) {
  const raw = String(size ?? "R1").trim().toUpperCase();
  return raw || "R1";
}

/**
 * Sow bottles of one size. Empty size means R1. Does not touch other sizes.
 */
export function applySow(ledger, { bottles, expectedPlants, size, sowDate, readyDays }) {
  const sowSize = normalizeSize(size);
  if (!SIZES.includes(sowSize)) return { error: "Choose R1, R2, or R3" };
  const count = Math.floor(Number(bottles) || 0);
  const expected = Math.floor(Number(expectedPlants) || 0);
  if (count < 1) return { error: "Enter bottles to sow" };
  if (expected < 1) return { error: "Enter expected plants" };
  const taken = takeBottles(
    (ledger.receipts || []).map((row) => ({ ...row })),
    count,
    sowSize
  );
  if (!taken) return { error: `Not enough ${sowSize} bottles on hand` };
  const mortality = mortalityExpectedPlants(expected);
  const days = Math.max(1, Math.floor(Number(readyDays) || 1));
  const day = sowDate instanceof Date ? sowDate : parseDay(sowDate) || istToday();
  if (!day) return { error: "Sow date is invalid" };
  return {
    receipts: taken.receipts,
    bottlesLeft: Math.max(0, Math.floor(Number(ledger.bottlesLeft) || 0) - count),
    bottlesSown: Math.floor(Number(ledger.bottlesSown) || 0) + count,
    expectedPlants: Math.floor(Number(ledger.expectedPlants) || 0) + expected,
    mortalityExpectedPlants: Math.floor(Number(ledger.mortalityExpectedPlants) || 0) + mortality,
    sow: {
      sowDate: day,
      bottlesUsed: count,
      size: sowSize,
      expectedPlants: expected,
      mortalityExpectedPlants: mortality,
      readyDate: addCalendarDays(day, days),
      plantsSent: 0,
    },
  };
}

export function applySend(sow, plants) {
  const count = Math.floor(Number(plants) || 0);
  if (count < 1) return { error: "Enter plants to send" };
  const gap = plantsNotSent(sow.mortalityExpectedPlants, sow.plantsSent);
  if (count > gap) return { error: `You can send up to ${gap} plants` };
  return {
    plantsSent: Math.floor(Number(sow.plantsSent) || 0) + count,
    plantsNotSent: gap - count,
    bottlesUnchanged: true,
  };
}

export function stockBySize(receipts, sows) {
  return SIZES.map((size) => {
    const ofSize = (receipts || []).filter((row) => row.size === size);
    const sown = (sows || []).filter((row) => row.size === size);
    const bottlesLeft = ofSize.reduce((sum, row) => sum + Math.max(0, Math.floor(Number(row.bottlesLeft) || 0)), 0);
    const bottlesReceived = ofSize.reduce((sum, row) => sum + Math.max(0, Math.floor(Number(row.bottles) || 0)), 0);
    const expectedPlants = sown.reduce((sum, row) => sum + Math.floor(Number(row.expectedPlants) || 0), 0);
    const mortalityExpectedPlants = sown.reduce(
      (sum, row) => sum + Math.floor(Number(row.mortalityExpectedPlants) || 0),
      0
    );
    const plantsSent = sown.reduce((sum, row) => sum + Math.floor(Number(row.plantsSent) || 0), 0);
    return {
      size,
      bottlesReceived,
      bottlesLeft,
      ...traySplit(bottlesLeft),
      expectedPlants,
      mortalityExpectedPlants,
      plantsSent,
      plantsNotSent: plantsNotSent(mortalityExpectedPlants, plantsSent),
    };
  }).filter((row) => row.bottlesReceived > 0 || row.expectedPlants > 0 || row.bottlesLeft > 0);
}

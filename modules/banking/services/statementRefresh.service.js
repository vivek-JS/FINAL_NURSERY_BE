/**
 * One ICICI statement pull per date window.
 * A second check in the next few minutes reuses the lines already saved.
 * An older payment asks for that payment's week only when those days are not covered.
 */

import { fetchAndStoreCorporateStatement } from "./iciciCorporateStatement.service.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const LOOKBACK_DAYS = 7;
const RECENT_SPAN_DAYS = 31;
const OLD_WINDOW_DAYS = 7;
const FRESH_MS = 3 * 60 * 1000;

/** @type {{ from: string, to: string, at: number }[]} */
const covered = [];
/** @type {Map<string, Promise<unknown>>} */
const inflight = new Map();

function ymdIst(date) {
  return new Date(date.getTime() + 330 * 60 * 1000).toISOString().slice(0, 10);
}

function windowFor(fromDate) {
  const end = new Date();
  const recentStart = new Date(end.getTime() - LOOKBACK_DAYS * DAY_MS);
  if (!fromDate) return { from: ymdIst(recentStart), to: ymdIst(end) };

  const dated = new Date(fromDate);
  if (Number.isNaN(dated.getTime()) || dated >= recentStart) {
    return { from: ymdIst(recentStart), to: ymdIst(end) };
  }

  const age = end.getTime() - dated.getTime();
  if (age <= RECENT_SPAN_DAYS * DAY_MS) {
    return { from: ymdIst(dated), to: ymdIst(end) };
  }

  const weekEnd = new Date(dated.getTime() + OLD_WINDOW_DAYS * DAY_MS);
  return { from: ymdIst(dated), to: ymdIst(weekEnd < end ? weekEnd : end) };
}

function alreadyCovered(from, to) {
  const now = Date.now();
  return covered.some((row) => row.at > now - FRESH_MS && row.from <= from && row.to >= to);
}

/**
 * @param {string|null} userId
 * @param {{ fromDate?: string|Date }} [options]
 */
export async function refreshRecentCorporateStatement(userId, { fromDate } = {}) {
  const { from, to } = windowFor(fromDate);
  if (alreadyCovered(from, to)) return { skipped: true, from, to };

  const key = `${from}|${to}`;
  const running = inflight.get(key);
  if (running) return running;

  const job = (async () => {
    const stored = await fetchAndStoreCorporateStatement(from, to, userId || null);
    covered.push({ from, to, at: Date.now() });
    if (covered.length > 24) covered.shift();
    return { skipped: false, from, to, stored };
  })();

  inflight.set(key, job);
  try {
    return await job;
  } finally {
    inflight.delete(key);
  }
}

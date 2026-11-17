/**
 * Keep the ICICI statement on disk.
 * A fetch only inserts lines that are not already saved.
 * After 12:00 IST the previous day and today are pulled. A longer archive
 * covers the last two months in 30-day chunks.
 */

import BankStatementEntry from "../../../models/bankStatementEntry.model.js";
import { fetchAndStoreCorporateStatement } from "./iciciCorporateStatement.service.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const CHUNK_DAYS = 30;
const ARCHIVE_DAYS = 62;

function ymdIst(date) {
  return new Date(date.getTime() + 330 * 60 * 1000).toISOString().slice(0, 10);
}

function istHour(date = new Date()) {
  return new Date(date.getTime() + 330 * 60 * 1000).getUTCHours();
}

async function syncRange(from, to, userId) {
  let cursor = new Date(from);
  const end = new Date(to);
  const parts = [];
  while (cursor <= end) {
    const chunkEnd = new Date(Math.min(end.getTime(), cursor.getTime() + (CHUNK_DAYS - 1) * DAY_MS));
    parts.push(await fetchAndStoreCorporateStatement(ymdIst(cursor), ymdIst(chunkEnd), userId || null));
    cursor = new Date(chunkEnd.getTime() + DAY_MS);
  }
  return parts;
}

/** Yesterday, and today once it is past noon IST. New lines only. */
export async function syncDueStatementDays(userId) {
  const now = new Date();
  const today = ymdIst(now);
  const yesterday = ymdIst(new Date(now.getTime() - DAY_MS));
  const from = istHour(now) >= 12 ? yesterday : ymdIst(new Date(now.getTime() - 2 * DAY_MS));
  const to = istHour(now) >= 12 ? today : yesterday;
  const stored = await fetchAndStoreCorporateStatement(from, to, userId || null);
  return { from, to, stored };
}

/** Skip the long pull when both a recent line and a line from about two months ago are stored. */
export async function statementArchiveMissing() {
  const now = Date.now();
  const recent = await BankStatementEntry.exists({
    source: "CORPORATE_HTTP",
    txnDate: { $gte: new Date(now - 3 * DAY_MS) },
  });
  const older = await BankStatementEntry.exists({
    source: "CORPORATE_HTTP",
    txnDate: { $gte: new Date(now - 60 * DAY_MS), $lte: new Date(now - 40 * DAY_MS) },
  });
  return !(recent && older);
}

/** Last two months, chunked so one ICICI call stays inside a month. */
export async function syncTwoMonthStatement(userId) {
  const end = new Date();
  const start = new Date(end.getTime() - ARCHIVE_DAYS * DAY_MS);
  const parts = await syncRange(start, end, userId);
  const inserted = parts.reduce((sum, part) => sum + Number(part?.inserted || 0), 0);
  return { from: ymdIst(start), to: ymdIst(end), chunks: parts.length, inserted };
}
